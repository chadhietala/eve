import type { ContextContainer } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import { resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import { dumpSession, formatTranscriptJsonl } from "#runtime/memory/session-dump.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

/**
 * Persists the current session transcript to memory when the agent has a memory
 * layer; otherwise a no-op (non-memory agents are unaffected).
 *
 * This is the seam the runtime calls at each step's commit point. The transcript
 * is dumped to `transcripts/<id>.jsonl` in the off-mount TRANSCRIPTS namespace of
 * EACH `rw` store the agent mounts — so a store's later dream sees every agent
 * that can write it. `ro` stores receive nothing, and the curated (mounted)
 * namespaces are never written here. The write key is content-addressed over the
 * rendered transcript and uses the session id as its turn coordinate, so
 * re-dumping within a session only writes when the transcript changed.
 */
export async function maybeDumpSession(
  ctx: ContextContainer,
  session: HarnessSession,
): Promise<void> {
  const config = ctx.get(MemoryConfigKey);
  if (config === undefined) {
    return;
  }

  const content = formatTranscriptJsonl(session.history);

  for (const store of config.stores) {
    if (store.access !== "rw") {
      continue;
    }
    const ns = resolveTranscriptsNamespace();
    const writeKey = buildWriteKey({
      namespace: ns,
      turnId: session.sessionId,
      seq: 0,
      content,
    });
    await dumpSession(store.backend, ns, {
      sessionId: session.sessionId,
      messages: session.history,
      writeKey,
    });
  }
}
