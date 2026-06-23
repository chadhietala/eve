import type { ContextContainer } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import { recordSessionTurns } from "#runtime/transcripts/record.js";

/**
 * Records the current session's new turns into the eve-owned transcript log when
 * the agent has one; otherwise a no-op (non-memory agents, and memory agents with
 * no `dream`, are unaffected).
 *
 * This is the seam the runtime calls at each step's commit point. The transcript
 * is a single session-level append-only log (not per store): the harness hands
 * the full {@link HarnessSession.history} each step, and this appends only the
 * turns not yet recorded, so the log accumulates the session's turns exactly once
 * across steps and replays. The log is eve-owned infrastructure — never mounted
 * under `/mnt/memory` and never readable by the model.
 */
export async function maybeDumpSession(
  ctx: ContextContainer,
  session: HarnessSession,
): Promise<void> {
  const config = ctx.get(MemoryConfigKey);
  if (config?.transcriptStore === undefined) {
    return;
  }

  await recordSessionTurns(config.transcriptStore, session.sessionId, session.history);
}
