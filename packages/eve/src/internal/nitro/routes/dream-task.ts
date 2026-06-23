import { buildMemoryConfigForBundle } from "#context/seed-memory-config.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import { runDreamTask } from "#runtime/memory/dream-task.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

/**
 * Cron-driven memory dream: runs the agent's dream over the current
 * transcript window, then prunes transcripts per retention.
 *
 * Loads the compiled bundle, builds its {@link MemoryConfig}
 * (via {@link buildMemoryConfigForBundle}), resolves the model (the agent's
 * configured model, or the dream's `model` override, via
 * {@link resolveRuntimeModelReference}), and delegates to
 * {@link runDreamTask}. A no-op when the agent declares no `dream` or the
 * window holds no new sessions.
 *
 * Registered as a cron-driven Nitro task by `registerDreamTaskHandler`
 * (see `createDreamRegistration` / `create-application-nitro.ts`)
 * whenever any agent in the bundle declares a memory `dream`, on that dream's
 * {@link DreamConfig.cron} cadence. The dispatch is single-agent per bundle:
 * it runs the root agent's dream over its `rw` stores.
 *
 * Time is read at this Nitro boundary (`Date.now()` in the generated task
 * `run`) and injected downstream, so the orchestration stays clock-pure.
 */
export async function dispatchDream(
  config: NitroArtifactsConfig,
  input: { readonly now: number },
): Promise<{ ran: number }> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });

  const memoryConfig = await buildMemoryConfigForBundle(bundle);
  if (memoryConfig?.dream === undefined) {
    return { ran: 0 };
  }

  const scope = { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId };
  const dreamModelId = memoryConfig.dream.model;
  const model =
    dreamModelId !== undefined
      ? await resolveRuntimeModelReference({ id: dreamModelId }, scope)
      : await resolveRuntimeModelReference(bundle.resolvedAgent.config.model, scope);

  return runDreamTask(memoryConfig, { model, now: input.now });
}
