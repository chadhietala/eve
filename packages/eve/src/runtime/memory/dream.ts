import type { LanguageModel } from "ai";

import type { DreamContext, DreamMemoryAccess } from "#public/definitions/memory.js";
import { runDreamAgent } from "#runtime/memory/dream-agent.js";
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";
import type { TranscriptStore } from "#runtime/transcripts/store.js";
import { resolveWindow } from "#runtime/transcripts/window.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Inputs for {@link buildDreamContext}. */
export interface BuildDreamContextInput {
  /** The store's backend — the only area the dream writes. */
  readonly backend: MemoryStore;
  /** The windowed session transcripts — the dream's immutable input. */
  readonly sessions: DreamContext["sessions"];
  /** The resolved model the synthesis calls. */
  readonly model: LanguageModel;
  /** Optional free-text guidance steering what the synthesis keeps/merges/drops. */
  readonly instructions?: string;
}

/**
 * Builds the {@link DreamContext} a dream runs against for one store.
 *
 * `sessions` is the pre-read window of session-level transcripts (the same window
 * is shared across every store's dream in a single dream). `memory` is a
 * read/write/list facade over the store's backend only, so a dream — the default
 * or an override — physically cannot write back to its own source material (the
 * transcript log). Writes are content-addressed via {@link buildWriteKey} so a
 * replayed dream is idempotent.
 */
export function buildDreamContext(input: BuildDreamContextInput): DreamContext {
  const memory = createMemoryAccess(input.backend);

  const context: {
    instructions?: string;
    model: LanguageModel;
    sessions: DreamContext["sessions"];
    memory: DreamMemoryAccess;
  } = {
    model: input.model,
    sessions: input.sessions,
    memory,
  };

  if (input.instructions !== undefined) {
    context.instructions = input.instructions;
  }

  return context;
}

/**
 * Runs the memory dream for a turn's {@link MemoryConfig}.
 *
 * Reads one window of the eve-owned, session-level transcript log (its lookback
 * from `config.dream.window`, resolved against `now`). With no `run` override the
 * default is an **agent** ({@link runDreamAgent}): the model gets the file tools
 * mounted over the writable stores plus a `read_transcripts` tool and updates
 * memory itself. An author `run` override instead receives a per-`rw`-store
 * {@link DreamContext} (sessions + that store's curated `memory`). A no-op when
 * the agent declares no `dream`, has no transcript log, or the window is empty.
 */
export async function runDream(
  config: MemoryConfig,
  input: { readonly model: LanguageModel; readonly now: number },
): Promise<void> {
  if (config.dream === undefined || config.transcriptStore === undefined) {
    return;
  }

  // No writable store ⇒ nothing to dream into; skip before spending a model.
  if (!config.stores.some((store) => store.access === "rw")) {
    return;
  }

  const sessions = await readWindowedSessions(
    config.transcriptStore,
    resolveWindow(input.now, config.dream.window),
  );
  if (sessions.length === 0) {
    return;
  }

  // Default: the dream is an agent over the mounted memory filesystem.
  if (config.dream.run === undefined) {
    const agentInput: {
      config: MemoryConfig;
      model: LanguageModel;
      sessions: typeof sessions;
      instructions?: string;
    } = {
      config,
      model: input.model,
      sessions,
    };
    if (config.dream.instructions !== undefined) {
      agentInput.instructions = config.dream.instructions;
    }
    await runDreamAgent(agentInput);
    return;
  }

  // Escape hatch: the author's `run` folds each writable store itself,
  // over the shared window of transcripts.
  for (const store of config.stores) {
    if (store.access !== "rw") {
      continue;
    }

    const buildInput: Mutable<BuildDreamContextInput> = {
      backend: store.backend,
      sessions,
      model: input.model,
    };
    const instructions = composeInstructions(config.dream.instructions, store);
    if (instructions !== undefined) {
      buildInput.instructions = instructions;
    }

    const ctx = buildDreamContext(buildInput);
    await config.dream.run(ctx);
  }
}

/**
 * Steers a store's dream by combining the dream's free-text
 * `instructions` with the store's `description` (the routing signal — "only keep
 * what belongs in this store"). Either, both, or neither may be present.
 */
function composeInstructions(
  instructions: string | undefined,
  store: MountedStore,
): string | undefined {
  const parts: string[] = [];
  if (store.description !== undefined) {
    parts.push(
      `This store ("${store.name}") holds: ${store.description} Keep only memory that belongs here.`,
    );
  }
  if (instructions !== undefined) {
    parts.push(instructions);
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * Reads the session transcripts in `window` from the log, rendering each
 * session's turns as JSONL — the same shape the synthesis consumes.
 */
async function readWindowedSessions(
  store: TranscriptStore,
  window: ReturnType<typeof resolveWindow>,
): Promise<DreamContext["sessions"]> {
  const infos = await store.list(window);
  const sessions: { sessionId: string; transcript: string }[] = [];
  for (const info of infos) {
    const turns = await store.read(info.sessionId);
    if (turns === null || turns.length === 0) {
      continue;
    }
    sessions.push({
      sessionId: info.sessionId,
      transcript: turns.map((turn) => JSON.stringify(turn)).join("\n"),
    });
  }
  return sessions;
}

/**
 * Builds the {@link DreamMemoryAccess} facade over a store's backend. Reads,
 * writes, and lists resolve against that backend only — there is no path by
 * which this facade reaches the transcript log, which is the guarantee that the
 * dream never mutates its input.
 */
function createMemoryAccess(backend: MemoryStore): DreamMemoryAccess {
  return {
    async read(path: string): Promise<string | null> {
      const bytes = await backend.read(path);
      return bytes === null ? null : decoder.decode(bytes);
    },
    async write(path: string, content: string): Promise<void> {
      const bytes = encoder.encode(content);
      // The dream runs outside a tool-loop turn, so it has no `(turnId, seq)`
      // coordinates; the path plus a content hash give a stable, content-addressed
      // write key so a replayed dream that produces the same memory is a
      // no-op in the store.
      const writeKey = buildWriteKey({ turnId: `dream:${path}`, seq: 0, content: bytes });
      await backend.write(path, bytes, writeKey);
    },
    async list(prefix: string): Promise<readonly string[]> {
      const entries = await backend.list(prefix);
      return entries.map((entry) => entry.path);
    },
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
