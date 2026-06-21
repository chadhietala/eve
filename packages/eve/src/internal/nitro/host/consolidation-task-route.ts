import type { Nitro } from "nitro/types";

import type { ConsolidationRegistration } from "#runtime/memory/consolidation-registration.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import type { NitroArtifactsConfigInput } from "#internal/nitro/host/artifacts-config.js";

/**
 * Virtual id for the synthetic Nitro task module emitted for the framework-owned
 * memory-consolidation backstop. A fixed id (not a prefix) because there is
 * exactly one consolidation task per deployment.
 */
const EVE_CONSOLIDATION_TASK_VIRTUAL_ID = "#eve-consolidation-task/sweep";

/**
 * The Nitro option surface this module mutates. Mirrors the schedule-task
 * surface so the consolidation backstop registers through the same `tasks` /
 * `scheduledTasks` / `virtual` seams Nitro reads when wiring cron handlers.
 */
interface ConsolidationTaskNitro {
  options: Pick<Nitro["options"], "experimental" | "scheduledTasks" | "tasks" | "virtual">;
}

/**
 * Inputs needed to wire the compiled consolidation registration into Nitro's
 * task and cron surfaces.
 *
 * `dispatchModulePath` is the absolute path of `dispatchConsolidationSweep`'s
 * module — the synthetic task module imports it and forwards the baked-in
 * artifacts config plus a boundary `Date.now()`.
 */
export interface RegisterConsolidationTaskHandlerInput {
  readonly artifactsConfig: NitroArtifactsConfigInput;
  readonly dispatchModulePath: string;
  readonly registration: ConsolidationRegistration;
}

/**
 * Registers the framework-owned consolidation backstop as a virtual Nitro task
 * handler driven on a cron cadence.
 *
 * Mirrors {@link registerScheduleTaskHandlers} exactly, but for a single fixed
 * task rather than one-per-source: it adds
 *   - one entry in `nitro.options.tasks` whose `handler` points at a virtual
 *     module wrapping `dispatchConsolidationSweep` in a Nitro task object,
 *   - one entry in `nitro.options.scheduledTasks[cron]` so Nitro's cron
 *     scheduler dispatches the sweep on the registration's cadence.
 *
 * The synthetic module exists because Nitro requires task modules to
 * default-export an object with a `run` method. `dispatchConsolidationSweep` is
 * a plain async function — the virtual module adapts it to Nitro's task
 * contract while baking in the artifacts config so the handler depends on no
 * global runtime configuration store. `Date.now()` is read inside the generated
 * `run` (the Nitro/cron boundary) and injected into the otherwise time-pure
 * orchestration.
 */
export function registerConsolidationTaskHandler(
  nitro: ConsolidationTaskNitro,
  input: RegisterConsolidationTaskHandlerInput,
): void {
  nitro.options.experimental.tasks = true;

  const dispatchModulePath = stringifyEsmImportSpecifier(input.dispatchModulePath);

  nitro.options.tasks[input.registration.taskName] = {
    description: input.registration.description,
    handler: EVE_CONSOLIDATION_TASK_VIRTUAL_ID,
  };

  // Nitro's `defineTask` is a passthrough that only installs a guard `run` when
  // one is missing — we always provide one, so we export the task object
  // directly. Importing from `"nitro/task"` would fail at runtime on Vercel
  // because `nitro` is a build-only dependency absent from the deployed trace.
  nitro.options.virtual[EVE_CONSOLIDATION_TASK_VIRTUAL_ID] = [
    `import { dispatchConsolidationSweep } from ${dispatchModulePath};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default {`,
    `  meta: { description: ${JSON.stringify(input.registration.description)} },`,
    `  async run() {`,
    `    return { result: await dispatchConsolidationSweep(config, { now: Date.now() }) };`,
    `  },`,
    `};`,
  ].join("\n");

  appendScheduledTask(nitro, input.registration.cron, input.registration.taskName);
}

function appendScheduledTask(nitro: ConsolidationTaskNitro, cron: string, taskName: string): void {
  const existingScheduledTasks = nitro.options.scheduledTasks[cron];

  if (existingScheduledTasks === undefined) {
    nitro.options.scheduledTasks[cron] = taskName;
    return;
  }

  if (typeof existingScheduledTasks === "string") {
    nitro.options.scheduledTasks[cron] = [existingScheduledTasks, taskName];
    return;
  }

  if (!existingScheduledTasks.includes(taskName)) {
    existingScheduledTasks.push(taskName);
  }
}
