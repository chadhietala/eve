import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  type CompiledMemory,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  DEFAULT_DREAM_CRON,
  EVE_DREAM_TASK_NAME,
  createDreamRegistration,
  manifestHasDream,
} from "#runtime/memory/dream-registration.js";

const AGENT_ROOT = "/app/agent";
const APP_ROOT = "/app";
const MODEL = { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } } as const;

function memory(dream?: CompiledMemory["dream"]): CompiledMemory {
  const base: CompiledMemory = {
    name: "memory",
    logicalPath: "memory.ts",
    root: "/mnt/memory",
    stores: [{ name: "notes" }],
    sourceId: "memory.ts",
    sourceKind: "module",
  };
  return dream === undefined ? base : { ...base, dream };
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
    expect(manifestHasDream(rootManifest({ memory: memory() }))).toBe(false);
  });

  it("is true when the root agent declares a dream", () => {
    expect(manifestHasDream(rootManifest({ memory: memory({ hasRun: false }) }))).toBe(true);
  });

  it("is true when only a subagent declares a dream", () => {
    const manifest = rootManifest({
      memory: memory(),
      subagents: [subagentWithMemory("research", memory({ hasRun: false }))],
    });
    expect(manifestHasDream(manifest)).toBe(true);
  });
});

describe("createDreamRegistration", () => {
  it("returns undefined when no agent declares a dream", () => {
    expect(createDreamRegistration(rootManifest({ memory: memory() }))).toBeUndefined();
  });

  it("defaults to the daily cron when the dream declares none", () => {
    const registration = createDreamRegistration(
      rootManifest({ memory: memory({ hasRun: false }) }),
    );
    expect(registration).toEqual({
      cron: DEFAULT_DREAM_CRON,
      description: "Run agents' memory dream (the dream).",
      taskName: EVE_DREAM_TASK_NAME,
    });
  });

  it("uses the dream's declared cron cadence", () => {
    const registration = createDreamRegistration(
      rootManifest({ memory: memory({ hasRun: false, cron: "*/30 * * * *" }) }),
    );
    expect(registration?.cron).toBe("*/30 * * * *");
  });
});
