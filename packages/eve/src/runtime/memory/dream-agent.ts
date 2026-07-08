import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from "ai";

import { ContextContainer, contextStorage } from "#context/container.js";
import { memoryGrep, memoryList, memoryRead, memoryWrite } from "#runtime/memory/store-access.js";
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";

/**
 * Upper bound on the dream agent's tool-loop steps. Generous enough to read the
 * transcripts, inspect the stores, and write several files, but bounded so a
 * misbehaving model can't loop forever.
 */
const MAX_DREAM_STEPS = 24;

/** The windowed session transcripts the dream agent folds into memory. */
export type DreamSessions = readonly {
  readonly sessionId: string;
  readonly transcript: string;
}[];

/** Inputs for {@link runDreamAgent}. */
export interface DreamAgentInput {
  /** The resolved memory config — its `rw` stores are the agent's writable filesystem. */
  readonly config: MemoryConfig;
  /** The model that drives the dream loop. */
  readonly model: LanguageModel;
  /** The windowed transcripts, surfaced to the agent through `read_transcripts`. */
  readonly sessions: DreamSessions;
  /** Optional author guidance steering what to keep/merge/drop. */
  readonly instructions?: string;
}

/**
 * Runs the default dream as an **agent** over the memory filesystem.
 *
 * The dream is a model loop with the agent's own file tools bound — `read_file`,
 * `write_file`, `list_files`, `grep` operate directly on the store backends (so
 * writes are versioned + CAS, and `ro` stores reject writes), plus a
 * `read_transcripts` tool that returns the windowed sessions. The dream runs
 * with no sandbox, so it reaches memory through the store backends rather than a
 * mount. The model reads the recent sessions, inspects the current memory, and
 * updates whichever files fit under the store of its choosing. The stores are
 * resolved by seeding {@link MemoryConfigKey} in a fresh context the tools read.
 */
export async function runDreamAgent(input: DreamAgentInput): Promise<void> {
  const ctx = new ContextContainer();
  ctx.set(MemoryConfigKey, input.config);

  const tools = {
    read_transcripts: tool({
      description:
        "Return the recent session transcripts to fold in (the dream's source material).",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => formatSessions(input.sessions),
    }),
    read_file: tool({
      description: "Read a memory file. `path` is absolute, e.g. /mnt/memory/<store>/<file>.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path }) => (await memoryRead(path)) ?? `(no file at ${path})`,
    }),
    write_file: tool({
      description:
        "Create or overwrite a memory file in place. `path` is /mnt/memory/<store>/<file>.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      execute: async ({ path, content }) => {
        try {
          await memoryWrite(path, content);
          return `wrote ${path}`;
        } catch (error) {
          // Surface the failure (e.g. a read-only store) as a tool result the
          // model can react to, rather than aborting the whole dream.
          return error instanceof Error ? `error: ${error.message}` : "error: write failed";
        }
      },
    }),
    list_files: tool({
      description: "List memory files under a path, e.g. /mnt/memory/<store>.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path }) => {
        const entries = await memoryList(path);
        return entries.length === 0 ? "(no files)" : entries.join("\n");
      },
    }),
    grep: tool({
      description: "Search memory file contents for a literal substring under a path.",
      inputSchema: jsonSchema<{ path: string; pattern: string }>({
        type: "object",
        properties: { path: { type: "string" }, pattern: { type: "string" } },
        required: ["path", "pattern"],
        additionalProperties: false,
      }),
      execute: async ({ path, pattern }) => {
        const hits = await memoryGrep({
          prefix: path,
          pattern,
          ignoreCase: false,
          literal: true,
          limit: 100,
        });
        return hits.length === 0
          ? "(no matches)"
          : hits.map((hit) => `${hit.path}:${hit.lineNumber}: ${hit.line}`).join("\n");
      },
    }),
  };

  await contextStorage.run(ctx, () =>
    generateText({
      model: input.model,
      system: buildDreamSystemPrompt(input.config, input.instructions),
      prompt:
        "Review the recent sessions with read_transcripts, then update long-term memory under " +
        "/mnt/memory so the agent is better prepared next time.",
      tools,
      stopWhen: stepCountIs(MAX_DREAM_STEPS),
      temperature: 0,
    }),
  );
}

/**
 * Assembles the dream agent's system prompt: the dream framing, a note
 * for each writable store (name → mount path → `description`, the routing
 * signal), and the author's `instructions`.
 */
export function buildDreamSystemPrompt(config: MemoryConfig, instructions?: string): string {
  const writable = config.stores.filter((store) => store.access === "rw");
  const mountNotes = writable
    .map((store) => {
      const purpose = store.description === undefined ? "" : ` — ${store.description}`;
      return `- ${store.name}  →  ${store.mountPath}${purpose}`;
    })
    .join("\n");

  const lines = [
    "You are the agent dreaming over its recent sessions. Your job is to fold what was learned",
    "in those sessions into the agent's long-term memory so future sessions are better prepared.",
    "",
    "Use `read_transcripts` to read the recent sessions. Use `read_file`, `list_files`, and",
    "`grep` to inspect the current memory, and `write_file` to update it. Memory is a filesystem:",
    "many small, focused files at paths you choose — there is no single index file.",
    "",
    "You can write into these stores (put each fact in the one that fits):",
    mountNotes,
    "",
    "Keep durable facts, preferences, decisions, and open threads; drop transient chatter.",
    "Deduplicate, replace stale entries with the latest, and read a file before overwriting it.",
  ];

  if (instructions !== undefined) {
    lines.push("", `Additional guidance: ${instructions}`);
  }

  return lines.join("\n");
}

function formatSessions(sessions: DreamSessions): string {
  if (sessions.length === 0) {
    return "(no recent sessions)";
  }
  return sessions
    .map((session) => `### Session ${session.sessionId}\n${session.transcript}`)
    .join("\n\n");
}
