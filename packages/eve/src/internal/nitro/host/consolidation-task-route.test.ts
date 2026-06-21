import type { Nitro } from "nitro/types";
import { describe, expect, it } from "vitest";

import {
  EVE_CONSOLIDATION_CRON,
  EVE_CONSOLIDATION_TASK_NAME,
  type ConsolidationRegistration,
} from "#runtime/memory/consolidation-registration.js";
import { registerConsolidationTaskHandler } from "#internal/nitro/host/consolidation-task-route.js";

const DISPATCH_MODULE_PATH = "/framework/consolidate-task.ts";

const ARTIFACTS_CONFIG = {
  appRoot: "/tmp/test-agent",
  dev: false,
} as const;

const REGISTRATION: ConsolidationRegistration = {
  cron: EVE_CONSOLIDATION_CRON,
  description: "Sweep due eve memory-consolidation timers and run agents' dreams.",
  taskName: EVE_CONSOLIDATION_TASK_NAME,
};

describe("consolidation task route", () => {
  it("registers a single virtual task handler and cron entry", () => {
    const nitro = createNitroStub();

    registerConsolidationTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    expect(nitro.options.experimental.tasks).toBe(true);
    expect(nitro.options.tasks).toEqual({
      [EVE_CONSOLIDATION_TASK_NAME]: {
        description: REGISTRATION.description,
        handler: "#eve-consolidation-task/sweep",
      },
    });
    expect(nitro.options.scheduledTasks).toEqual({
      [EVE_CONSOLIDATION_CRON]: EVE_CONSOLIDATION_TASK_NAME,
    });
  });

  it("emits a plain task object that reads time at the Nitro boundary", () => {
    const nitro = createNitroStub();

    registerConsolidationTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    const virtualSource = nitro.options.virtual["#eve-consolidation-task/sweep"];
    expect(virtualSource).toBeDefined();
    // Same rationale as the schedule task: no `defineTask`/`nitro/task` import,
    // because `nitro` is a build-only dependency absent from the deployed trace.
    expect(virtualSource).not.toContain("nitro/task");
    expect(virtualSource).not.toContain("defineTask");
    expect(virtualSource).toContain(
      `import { dispatchConsolidationSweep } from ${JSON.stringify(DISPATCH_MODULE_PATH)};`,
    );
    expect(virtualSource).toContain(`const config = ${JSON.stringify(ARTIFACTS_CONFIG)};`);
    // Time is injected at the boundary, not threaded through the cron event.
    expect(virtualSource).toContain("dispatchConsolidationSweep(config, { now: Date.now() })");
  });

  it("appends to an existing cron entry without dropping other tasks", () => {
    const nitro = createNitroStub({
      scheduledTasks: { [EVE_CONSOLIDATION_CRON]: "user-task" },
      tasks: { "user-task": { description: "user", handler: "/user/task.ts" } },
    });

    registerConsolidationTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    expect(nitro.options.scheduledTasks).toEqual({
      [EVE_CONSOLIDATION_CRON]: ["user-task", EVE_CONSOLIDATION_TASK_NAME],
    });
    expect(nitro.options.tasks["user-task"]).toEqual({
      description: "user",
      handler: "/user/task.ts",
    });
  });
});

type NitroStubOptions = Pick<
  Nitro["options"],
  "experimental" | "scheduledTasks" | "tasks" | "virtual"
>;

function createNitroStub(
  input: {
    scheduledTasks?: NitroStubOptions["scheduledTasks"];
    tasks?: NitroStubOptions["tasks"];
    virtual?: NitroStubOptions["virtual"];
  } = {},
): { options: NitroStubOptions } {
  return {
    options: {
      experimental: { tasks: false },
      scheduledTasks: input.scheduledTasks ?? {},
      tasks: input.tasks ?? {},
      virtual: input.virtual ?? {},
    },
  };
}
