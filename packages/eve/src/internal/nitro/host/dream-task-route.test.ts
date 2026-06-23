import type { Nitro } from "nitro/types";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DREAM_CRON,
  EVE_DREAM_TASK_NAME,
  type DreamRegistration,
} from "#runtime/memory/dream-registration.js";
import { registerDreamTaskHandler } from "#internal/nitro/host/dream-task-route.js";

const DISPATCH_MODULE_PATH = "/framework/dream-task.ts";

const ARTIFACTS_CONFIG = {
  appRoot: "/tmp/test-agent",
  dev: false,
} as const;

const REGISTRATION: DreamRegistration = {
  cron: DEFAULT_DREAM_CRON,
  description: "Run agents' memory dream (the dream).",
  taskName: EVE_DREAM_TASK_NAME,
};

describe("dream task route", () => {
  it("registers a single virtual task handler and cron entry", () => {
    const nitro = createNitroStub();

    registerDreamTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    expect(nitro.options.experimental.tasks).toBe(true);
    expect(nitro.options.tasks).toEqual({
      [EVE_DREAM_TASK_NAME]: {
        description: REGISTRATION.description,
        handler: "#eve-dream-task/run",
      },
    });
    expect(nitro.options.scheduledTasks).toEqual({
      [DEFAULT_DREAM_CRON]: EVE_DREAM_TASK_NAME,
    });
  });

  it("emits a plain task object that reads time at the Nitro boundary", () => {
    const nitro = createNitroStub();

    registerDreamTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    const virtualSource = nitro.options.virtual["#eve-dream-task/run"];
    expect(virtualSource).toBeDefined();
    // Same rationale as the schedule task: no `defineTask`/`nitro/task` import,
    // because `nitro` is a build-only dependency absent from the deployed trace.
    expect(virtualSource).not.toContain("nitro/task");
    expect(virtualSource).not.toContain("defineTask");
    expect(virtualSource).toContain(
      `import { dispatchDream } from ${JSON.stringify(DISPATCH_MODULE_PATH)};`,
    );
    expect(virtualSource).toContain(`const config = ${JSON.stringify(ARTIFACTS_CONFIG)};`);
    // Time is injected at the boundary, not threaded through the cron event.
    expect(virtualSource).toContain("dispatchDream(config, { now: Date.now() })");
  });

  it("appends to an existing cron entry without dropping other tasks", () => {
    const nitro = createNitroStub({
      scheduledTasks: { [DEFAULT_DREAM_CRON]: "user-task" },
      tasks: { "user-task": { description: "user", handler: "/user/task.ts" } },
    });

    registerDreamTaskHandler(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registration: REGISTRATION,
    });

    expect(nitro.options.scheduledTasks).toEqual({
      [DEFAULT_DREAM_CRON]: ["user-task", EVE_DREAM_TASK_NAME],
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
