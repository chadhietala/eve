import { parseDuration } from "#runtime/transcripts/duration.js";
import type { TranscriptWindow } from "#runtime/transcripts/store.js";

/**
 * Default lookback when a dream declares no `window`: 24 hours. Generous enough
 * that a dream sees a day's sessions, while bounded so the synthesis input stays
 * reasonable.
 */
export const DEFAULT_DREAM_WINDOW_MS = 86_400_000;

/**
 * Resolves a dream's lookback into a concrete {@link TranscriptWindow} ending at
 * `now`. A `lookback` duration (e.g. `"12h"`) selects `[now - lookback, now)`;
 * omitting it falls back to {@link DEFAULT_DREAM_WINDOW_MS}. The `until` bound is
 * left open so a transcript written between resolution and the listing still
 * counts as "touched in the window".
 */
export function resolveWindow(now: number, lookback?: string | number): TranscriptWindow {
  const span = lookback === undefined ? DEFAULT_DREAM_WINDOW_MS : parseDuration(lookback);
  return { since: now - span };
}

/**
 * Resolves a retention `maxAge` into the cutoff timestamp for
 * {@link TranscriptStore.prune}: transcripts last touched before
 * `now - maxAge` are eligible for removal.
 */
export function resolveRetentionCutoff(now: number, maxAge: string | number): number {
  return now - parseDuration(maxAge);
}
