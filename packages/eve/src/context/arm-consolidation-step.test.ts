import { describe, expect, it } from "vitest";

import { maybeArmConsolidation } from "#context/arm-consolidation-step.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { CONSOLIDATE_TASK_NAME, consolidationTimerKey } from "#runtime/memory/consolidate-task.js";
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";
import { InMemoryTimerStore } from "#runtime/timer/store.js";

const AGENT_ID = "agent-1";

const MOUNTED_NAMESPACE: MemoryNamespace = {
  agentId: AGENT_ID,
  scopeId: AGENT_ID,
  scopeType: "working",
};

const SESSIONS_NAMESPACE: MemoryNamespace = {
  agentId: AGENT_ID,
  scopeId: AGENT_ID,
  scopeType: "sessions",
};

function makeConfig(dream?: MemoryConfig["dream"]): MemoryConfig {
  const config: MemoryConfig = {
    namespace: MOUNTED_NAMESPACE,
    sessionsNamespace: SESSIONS_NAMESPACE,
    root: "/memory",
    store: new InMemoryMemoryStore(),
  };
  if (dream !== undefined) {
    return { ...config, dream };
  }
  return config;
}

async function withMemory<T>(
  config: MemoryConfig | undefined,
  fn: (ctx: ContextContainer) => Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer();
  if (config !== undefined) {
    ctx.set(MemoryConfigKey, config);
  }
  return contextStorage.run(ctx, () => fn(ctx)) as Promise<T>;
}

describe("maybeArmConsolidation", () => {
  it("arms a timer keyed by agent at now + idleMs when idleMs is set", async () => {
    const timerStore = new InMemoryTimerStore();
    const config = makeConfig({ schedule: { idleMs: 5000 } });

    await withMemory(config, (ctx) => maybeArmConsolidation(ctx, 1000, timerStore));

    const record = await timerStore.get(consolidationTimerKey(AGENT_ID));
    expect(record).not.toBeNull();
    expect(record?.dueAt).toBe(6000);
    expect(record?.status).toBe("armed");
    expect(record?.task).toEqual({
      name: CONSOLIDATE_TASK_NAME,
      payload: { agentId: AGENT_ID },
    });
  });

  it("slides the deadline forward when re-armed on a later step", async () => {
    const timerStore = new InMemoryTimerStore();
    const config = makeConfig({ schedule: { idleMs: 5000 } });

    await withMemory(config, (ctx) => maybeArmConsolidation(ctx, 1000, timerStore));
    await withMemory(config, (ctx) => maybeArmConsolidation(ctx, 4000, timerStore));

    const record = await timerStore.get(consolidationTimerKey(AGENT_ID));
    // The latest arm wins: a single timer slid to 4000 + 5000, not two timers.
    expect(record?.dueAt).toBe(9000);
    expect(record?.status).toBe("armed");
  });

  it("is a no-op when the dream declares no idle schedule", async () => {
    const timerStore = new InMemoryTimerStore();
    const config = makeConfig({ schedule: { cron: "0 0 * * *" } });

    await withMemory(config, (ctx) => maybeArmConsolidation(ctx, 1000, timerStore));

    expect(await timerStore.get(consolidationTimerKey(AGENT_ID))).toBeNull();
  });

  it("is a no-op when the agent declares no dream", async () => {
    const timerStore = new InMemoryTimerStore();

    await withMemory(makeConfig(), (ctx) => maybeArmConsolidation(ctx, 1000, timerStore));

    expect(await timerStore.get(consolidationTimerKey(AGENT_ID))).toBeNull();
  });

  it("is a no-op when no MemoryConfig is seeded (non-memory agent)", async () => {
    const timerStore = new InMemoryTimerStore();

    await withMemory(undefined, (ctx) => maybeArmConsolidation(ctx, 1000, timerStore));

    expect(await timerStore.get(consolidationTimerKey(AGENT_ID))).toBeNull();
  });
});
