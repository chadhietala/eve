import type { ModelMessage } from "ai";

import type { MemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace, WriteKey } from "#runtime/memory/types.js";

/**
 * Renders a session transcript to JSON Lines — one {@link ModelMessage} per
 * line, serialized verbatim.
 *
 * The dump is the raw, full-fidelity record of a session: every message,
 * including tool calls, tool results, files, and reasoning, is preserved exactly
 * as the model saw it. This is the source material a consolidation ("dream") or
 * a custom pipeline (KG, RAG) mines — so it favors completeness and
 * round-trippability over human prose. It stays greppable: each line is a JSON
 * object whose text content is searchable. A readable, summarized view is the
 * job of consolidation, not of the dump.
 */
export function formatTranscriptJsonl(messages: readonly ModelMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

/**
 * Maps a session id to its raw transcript path within the memory namespace:
 * `sessions/<id>/transcript.jsonl`. The per-session directory leaves room for a
 * consolidation step to write derived artifacts (e.g. a summary) alongside the
 * raw transcript.
 *
 * The id is sanitized to a single safe path segment so a hostile or composite
 * id (one containing `/` or `..`) cannot escape the `sessions/` directory.
 */
export function transcriptPath(sessionId: string): string {
  const safe = sessionId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_");
  return `sessions/${safe}/transcript.jsonl`;
}

/** Inputs for {@link dumpSession}. */
export interface DumpSessionInput {
  readonly sessionId: string;
  readonly messages: readonly ModelMessage[];
  readonly writeKey: WriteKey;
}

/**
 * Persists a session's raw transcript (JSONL) to the agent's memory store.
 *
 * Writes {@link formatTranscriptJsonl} under {@link transcriptPath} using the
 * supplied content-addressed {@link WriteKey}, so re-dumping identical content
 * is a no-op (the store dedups on the key). This is what makes per-step dumps
 * safe to run repeatedly across a turn's tool loop — each step rewrites the
 * latest transcript, and an unchanged transcript writes nothing.
 */
export async function dumpSession(
  store: MemoryStore,
  ns: MemoryNamespace,
  input: DumpSessionInput,
): Promise<void> {
  const bytes = new TextEncoder().encode(formatTranscriptJsonl(input.messages));
  await store.write(ns, transcriptPath(input.sessionId), bytes, input.writeKey);
}
