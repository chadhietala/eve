import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  type CompiledMemory,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  EVE_CONSOLIDATION_CRON,
  EVE_CONSOLIDATION_TASK_NAME,
  createConsolidationRegistration,
  manifestHasDream,
} from "#runtime/memory/consolidation-registration.js";

const AGENT_ROOT = "/app/agent";
const APP_ROOT = "/app";
const MODEL = { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } } as const;

function memory(withDream: boolean): CompiledMemory {
  const base: CompiledMemory = {
    name: "memory",
    logicalPath: "memory.ts",
    root: "/mnt/memory",
    stores: [{ name: "notes" }],
    sourceId: "memory.ts",
    sourceKind: "module",
  };
  if (!withDream) {
    return base;
  }
  return { ...base, dream: { hasRun: false, schedule: { idleMs: 1000 } } };
}

function rootManifest(input: { memory?: CompiledMemory; subagents?: CompiledSubagentNode[] }) {
  const manifestInput: {
    agentRoot: string;
    appRoot: string;
    config: { model: typeof MODEL; name: string };
    memory?: CompiledMemory;
    subagents?: CompiledSubagentNode[];
  } = {
    agentRoot: AGENT_ROOT,
    appRoot: APP_ROOT,
    config: { model: MODEL, name: "root" },
  };
  if (input.memory !== undefined) {
    manifestInput.memory = input.memory;
  }
  if (input.subagents !== undefined) {
    manifestInput.subagents = input.subagents;
  }
  return createCompiledAgentManifest(manifestInput);
}

function subagentWithMemory(name: string, memoryConfig: CompiledMemory): CompiledSubagentNode {
  return {
    agent: createCompiledAgentNodeManifest({
      agentRoot: `${AGENT_ROOT}/subagents/${name}`,
      appRoot: APP_ROOT,
      config: { model: MODEL, name },
      memory: memoryConfig,
    }),
    description: `${name} subagent`,
    entryPath: `subagents/${name}/agent.ts`,
    exportName: undefined,
    logicalPath: `subagents/${name}`,
    name,
    nodeId: name,
    rootPath: `subagents/${name}`,
    sourceId: `subagents/${name}/agent.ts`,
    sourceKind: "module",
  };
}

describe("manifestHasDream", () => {
  it("is false for a non-memory agent", () => {
    expect(manifestHasDream(rootManifest({}))).toBe(false);
  });

  it("is false for a memory agent that declares no dream", () => {
    expect(manifestHasDream(rootManifest({ memory: memory(false) }))).toBe(false);
  });

  it("is true when the root agent declares a dream", () => {
    expect(manifestHasDream(rootManifest({ memory: memory(true) }))).toBe(true);
  });

  it("is true when only a subagent declares a dream", () => {
    const manifest = rootManifest({
      memory: memory(false),
      subagents: [subagentWithMemory("research", memory(true))],
    });
    expect(manifestHasDream(manifest)).toBe(true);
  });
});

describe("createConsolidationRegistration", () => {
  it("returns undefined when no agent declares a dream", () => {
    expect(
      createConsolidationRegistration(rootManifest({ memory: memory(false) })),
    ).toBeUndefined();
  });

  it("returns the fixed task + cron registration when a dream exists", () => {
    const registration = createConsolidationRegistration(rootManifest({ memory: memory(true) }));
    expect(registration).toEqual({
      cron: EVE_CONSOLIDATION_CRON,
      description: "Sweep due eve memory-consolidation timers and run agents' dreams.",
      taskName: EVE_CONSOLIDATION_TASK_NAME,
    });
  });
});
