import type { ContextContainer } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import { dumpSession, formatTranscriptJsonl } from "#runtime/memory/session-dump.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

/**
 * Persists the current session transcript to memory when the agent has a memory
 * layer; otherwise a no-op (non-memory agents are unaffected).
 *
 * This is the seam the runtime calls at each step's commit point. The write key
 * is content-addressed over the rendered transcript and uses the session id as
 * its turn coordinate, so re-dumping within a session only writes when the
 * transcript changed — each successful step persists the latest transcript
 * while replays and unchanged steps are deduped by the store.
 *
 * The transcript lands in the off-mount `sessionsNamespace` (the raw, immutable
 * source-of-truth area), never in the mounted memory namespace the agent reads
 * through `/memory`.
 */
export async function maybeDumpSession(
  ctx: ContextContainer,
  session: HarnessSession,
): Promise<void> {
  const config = ctx.get(MemoryConfigKey);
  if (config === undefined) {
    return;
  }

  const writeKey = buildWriteKey({
    namespace: config.sessionsNamespace,
    turnId: session.sessionId,
    seq: 0,
    content: formatTranscriptJsonl(session.history),
  });

  await dumpSession(config.store, config.sessionsNamespace, {
    sessionId: session.sessionId,
    messages: session.history,
    writeKey,
  });
}
