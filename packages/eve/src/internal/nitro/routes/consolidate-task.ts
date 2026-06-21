import type { LanguageModel } from "ai";

import { buildMemoryConfigForBundle } from "#context/seed-memory-config.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import { runDueConsolidations } from "#runtime/memory/consolidate-task.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { FsTimerStore } from "#runtime/timer/fs-store.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Cron backstop: sweeps every due memory-consolidation timer and runs the
 * agents' dreams.
 *
 * This is the fire path the durable idle timer and a cron backstop share. The
 * idle timer (armed at each active step) makes consolidation responsive; this
 * task — driven on a cron cadence — is the catch-up that guarantees a due timer
 * eventually fires even if no step ran to trigger a sweep.
 *
 * It loads the compiled bundle once, derives `loadConfig` (bundle →
 * {@link MemoryConfig} via {@link buildMemoryConfigForBundle}) and `resolveModel`
 * (the agent's configured model, or the dream's `model` override, resolved via
 * {@link resolveRuntimeModelReference}), constructs the durable
 * {@link FsTimerStore}, and delegates to {@link runDueConsolidations} for the
 * fully-injected, unit-tested orchestration.
 *
 * Wiring-only: this entrypoint typechecks and builds, but the cron/Nitro
 * registration that invokes it is not exercised in this environment.
 */
export async function dispatchConsolidationSweep(
  config: NitroArtifactsConfig,
  input: { readonly now: number },
): Promise<{ ran: number }> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

  // One bundle serves both deps. The sweep is single-agent per bundle today, so
  // `loadConfig` ignores the requested id and returns this bundle's config; the
  // timer payload's `agentId` is still the matching key. When the runtime hosts
  // multiple agents per deployment, this is where a multi-agent lookup lands.
  const loadConfig = async (_agentId: string): Promise<MemoryConfig | undefined> => {
    return buildMemoryConfigForBundle(bundle);
  };

  const resolveModel = async (memoryConfig: MemoryConfig): Promise<LanguageModel> => {
    const dreamModelId = memoryConfig.dream?.model;
    if (dreamModelId !== undefined) {
      return resolveRuntimeModelReference({ id: dreamModelId }, { compiledArtifactsSource });
    }
    return resolveRuntimeModelReference(bundle.resolvedAgent.config.model, {
      compiledArtifactsSource,
    });
  };

  return runDueConsolidations({
    timerStore: new FsTimerStore(),
    now: input.now,
    loadConfig,
    resolveModel,
  });
}
