import { generateText, type LanguageModel } from "ai";

import type { DreamContext, DreamMemoryAccess } from "#public/definitions/memory.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

/** Directory the off-mount session transcripts land under within a store. */
const TRANSCRIPTS_PREFIX = "transcripts/";
/** Filename suffix every per-session transcript dump lands at. */
const TRANSCRIPT_SUFFIX = ".jsonl";

/** The curated memory file the default synthesis reads from and writes back to. */
const DEFAULT_MEMORY_FILE = "MEMORY.md";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The system prompt for the built-in default dream. It frames the model as a
 * memory consolidator and spells out the fold-in policy (dedupe, replace stale,
 * keep the latest), so the default synthesis behaves predictably without the
 * author having to restate it. Author `instructions`, when present, are layered
 * on top as an additional user message — they steer, they do not replace.
 */
const DEFAULT_DREAM_SYSTEM_PROMPT = [
  "You are the agent's memory consolidator.",
  "You are given the agent's current long-term memory and the raw transcripts of recent sessions.",
  "Fold the new sessions into the existing memory and return the complete, updated memory document.",
  "Keep durable facts, preferences, decisions, and open threads; drop transient chatter.",
  "Deduplicate repeated facts, replace stale information with the latest, and preserve the existing structure where it still fits.",
  "Return only the updated memory document — no preamble, no commentary.",
].join(" ");

/** Inputs for {@link buildDreamContext}. */
export interface BuildDreamContextInput {
  /** The store's backend both namespaces resolve against. */
  readonly backend: MemoryStore;
  /** The store's curated namespace — the dream's output, the only area written. */
  readonly curatedNamespace: MemoryNamespace;
  /** The store's off-mount transcripts namespace — the dream's immutable input. */
  readonly transcriptsNamespace: MemoryNamespace;
  /** The resolved model the synthesis calls. */
  readonly model: LanguageModel;
  /** Optional free-text guidance steering what the synthesis keeps/merges/drops. */
  readonly instructions?: string;
}

/**
 * Builds the {@link DreamContext} a consolidation runs against for one store.
 *
 * `sessions` is materialized by listing the transcripts namespace under
 * `transcripts/`, reading each `<id>.jsonl`, and deriving the session id from its
 * path. Those reads never mutate the transcripts area. `memory` is a
 * read/write/list facade bound to the curated namespace only, so a dream — the
 * default or an override — physically cannot write back to its own source
 * material. Writes are content-addressed via {@link buildWriteKey} so a replayed
 * consolidation is idempotent.
 */
export async function buildDreamContext(input: BuildDreamContextInput): Promise<DreamContext> {
  const sessions = await readSessions(input.backend, input.transcriptsNamespace);
  const memory = createMemoryAccess(input.backend, input.curatedNamespace);

  const context: {
    instructions?: string;
    model: LanguageModel;
    sessions: DreamContext["sessions"];
    memory: DreamMemoryAccess;
  } = {
    model: input.model,
    sessions,
    memory,
  };

  if (input.instructions !== undefined) {
    context.instructions = input.instructions;
  }

  return context;
}

/**
 * The built-in default consolidation, deliberately simple and meant to be
 * overridden by a {@link DreamContext}-consuming `run`.
 *
 * Reads the existing {@link DEFAULT_MEMORY_FILE} (if any) and every session
 * transcript, asks the model to fold the sessions into the prior memory under
 * {@link DEFAULT_DREAM_SYSTEM_PROMPT} (plus the author's `instructions`), and
 * writes the result back to {@link DEFAULT_MEMORY_FILE}. It only ever writes to
 * `ctx.memory`; the transcripts area is read-only by construction.
 */
export async function defaultDream(ctx: DreamContext): Promise<void> {
  // Nothing to consolidate: leave the curated memory untouched rather than
  // asking the model to rewrite it from nothing.
  if (ctx.sessions.length === 0) {
    return;
  }

  const existingMemory = await ctx.memory.read(DEFAULT_MEMORY_FILE);

  const result = await generateText({
    model: ctx.model,
    system: DEFAULT_DREAM_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: formatExistingMemorySection(existingMemory),
      },
      {
        role: "user",
        content: formatSessionsSection(ctx.sessions),
      },
      ...(ctx.instructions === undefined
        ? []
        : [{ role: "user" as const, content: `Consolidation guidance:\n${ctx.instructions}` }]),
    ],
    temperature: 0,
  });

  await ctx.memory.write(DEFAULT_MEMORY_FILE, result.text);
}

/**
 * Runs the memory consolidation for a turn's {@link MemoryConfig}, once per
 * `rw` store.
 *
 * For each writable store: builds the {@link DreamContext} from the store's
 * backend, its curated namespace, its transcripts namespace, and the model, then
 * dispatches to the author's `config.dream.run` override when present, otherwise
 * the {@link defaultDream}. `ro` stores are skipped (their transcripts are never
 * dumped, so there is nothing to consolidate). A no-op when the agent declares no
 * `dream`.
 */
export async function runDream(
  config: MemoryConfig,
  input: { readonly model: LanguageModel },
): Promise<void> {
  if (config.dream === undefined) {
    return;
  }

  const run = config.dream.run ?? defaultDream;

  for (const store of config.stores) {
    if (store.access !== "rw") {
      continue;
    }

    const buildInput: Mutable<BuildDreamContextInput> = {
      backend: store.backend,
      curatedNamespace: resolveStoreNamespace(),
      transcriptsNamespace: resolveTranscriptsNamespace(),
      model: input.model,
    };
    if (config.dream.instructions !== undefined) {
      buildInput.instructions = config.dream.instructions;
    }

    const ctx = await buildDreamContext(buildInput);
    await run(ctx);
  }
}

async function readSessions(
  backend: MemoryStore,
  transcriptsNamespace: MemoryNamespace,
): Promise<DreamContext["sessions"]> {
  const entries = await backend.list(transcriptsNamespace, TRANSCRIPTS_PREFIX);
  const sessions: { sessionId: string; transcript: string }[] = [];

  for (const entry of entries) {
    const sessionId = deriveSessionId(entry.path);
    if (sessionId === null) {
      continue;
    }
    const bytes = await backend.read(transcriptsNamespace, entry.path);
    if (bytes === null) {
      continue;
    }
    sessions.push({ sessionId, transcript: decoder.decode(bytes) });
  }

  return sessions;
}

/**
 * Recovers the session id from a `transcripts/<id>.jsonl` path. Returns `null`
 * for any path that does not match that exact shape so unrelated entries are
 * skipped rather than mis-keyed.
 */
function deriveSessionId(path: string): string | null {
  if (!path.startsWith(TRANSCRIPTS_PREFIX) || !path.endsWith(TRANSCRIPT_SUFFIX)) {
    return null;
  }
  const id = path.slice(TRANSCRIPTS_PREFIX.length, path.length - TRANSCRIPT_SUFFIX.length);
  if (id.length === 0 || id.includes("/")) {
    return null;
  }
  return id;
}

/**
 * Builds the {@link DreamMemoryAccess} facade over a store's curated namespace.
 * Reads/writes/lists resolve against `curatedNamespace` only — there is no path
 * by which this facade reaches the transcripts area, which is the guarantee that
 * the dream never mutates its input.
 */
function createMemoryAccess(
  backend: MemoryStore,
  curatedNamespace: MemoryNamespace,
): DreamMemoryAccess {
  return {
    async read(path: string): Promise<string | null> {
      const bytes = await backend.read(curatedNamespace, path);
      return bytes === null ? null : decoder.decode(bytes);
    },
    async write(path: string, content: string): Promise<void> {
      const bytes = encoder.encode(content);
      // The dream runs outside a tool-loop turn, so it has no `(turnId, seq)`
      // coordinates; the path plus a content hash give a stable, content-addressed
      // write key so a replayed consolidation that produces the same memory is a
      // no-op in the store.
      const writeKey = buildWriteKey({
        namespace: curatedNamespace,
        turnId: `dream:${path}`,
        seq: 0,
        content: bytes,
      });
      await backend.write(curatedNamespace, path, bytes, writeKey);
    },
    async list(prefix: string): Promise<readonly string[]> {
      const entries = await backend.list(curatedNamespace, prefix);
      return entries.map((entry) => entry.path);
    },
  };
}

function formatExistingMemorySection(existingMemory: string | null): string {
  if (existingMemory === null || existingMemory.trim().length === 0) {
    return "Current memory: (empty — this is the first consolidation)";
  }
  return `Current memory:\n${existingMemory}`;
}

function formatSessionsSection(sessions: DreamContext["sessions"]): string {
  const blocks = sessions.map(
    (session) => `### Session ${session.sessionId}\n${session.transcript}`,
  );
  return ["Recent session transcripts:", ...blocks].join("\n\n");
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
