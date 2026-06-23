import type { LanguageModel } from "ai";

import { runDream } from "#runtime/memory/dream.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { resolveRetentionCutoff } from "#runtime/transcripts/window.js";

/**
 * Runs one memory dream: the dream over the current transcript window,
 * then transcript retention pruning. Returns `{ ran: 0 }` when the agent
 * declares no `dream` (nothing to dream), `{ ran: 1 }` otherwise.
 *
 * `runDream` already no-ops when the window holds no sessions or the agent has
 * no writable store, so a cron tick with nothing new is cheap. Every dependency
 * — model and clock — is injected, so the orchestration is unit-testable without
 * a real model or wall clock. This is the body the cron-driven Nitro task runs.
 */
export async function runDreamTask(
  config: MemoryConfig,
  input: { readonly model: LanguageModel; readonly now: number },
): Promise<{ ran: number }> {
  if (config.dream === undefined) {
    return { ran: 0 };
  }
  await runDream(config, { model: input.model, now: input.now });
  await pruneTranscripts(config, input.now);
  return { ran: 1 };
}

/**
 * Enforces transcript retention after a dream: removes session
 * transcripts older than the configured retention `maxAge`. A no-op when the
 * agent has no transcript log or declared no retention.
 */
export async function pruneTranscripts(config: MemoryConfig, now: number): Promise<void> {
  if (config.transcriptStore === undefined || config.transcriptRetention === undefined) {
    return;
  }
  await config.transcriptStore.prune(resolveRetentionCutoff(now, config.transcriptRetention));
}
