import type { TranscriptStore, TranscriptTurn } from "#runtime/transcripts/store.js";

/**
 * Records a session's turns into the transcript log, appending only the turns
 * not already present.
 *
 * The harness hands the full, growing turn list at each step's commit; this reads
 * how many turns the log already holds for `sessionId` and appends the suffix, so
 * the log accumulates each turn exactly once across steps and idempotently across
 * a workflow replay (a replayed step sees the turns already recorded and appends
 * nothing). Returns the number of turns appended.
 */
export async function recordSessionTurns(
  store: TranscriptStore,
  sessionId: string,
  turns: readonly TranscriptTurn[],
): Promise<number> {
  const existing = (await store.read(sessionId)) ?? [];
  let appended = 0;
  for (let i = existing.length; i < turns.length; i += 1) {
    await store.append(sessionId, turns[i]);
    appended += 1;
  }
  return appended;
}
