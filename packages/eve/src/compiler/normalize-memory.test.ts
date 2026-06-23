import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { DISCOVER_MEMORY_MARKDOWN_UNSUPPORTED } from "#discover/grammar.js";
import { projectCompiledMemory } from "#compiler/normalize-memory.js";
import { defineMemory } from "#public/definitions/memory.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemorySourceRef } from "#discover/manifest.js";

const MODULE_SOURCE: MemorySourceRef = {
  sourceKind: "module",
  logicalPath: "memory.ts",
  sourceId: "memory.ts",
  exportName: undefined,
};

describe("memory discovery", () => {
  it("flags a stray memory.md with a diagnostic and does not treat it as a memory source", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "memory.md": "Remember the user prefers metric units.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.manifest.memory).toEqual([]);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === DISCOVER_MEMORY_MARKDOWN_UNSUPPORTED,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("memory.ts");
    expect(diagnostic?.message).toMatch(/markdown memory is not supported/);
  });

  it("flags a .md file inside the memory/ directory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "memory/notes.md": "Some notes.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.manifest.memory).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === DISCOVER_MEMORY_MARKDOWN_UNSUPPORTED)).toBe(
      true,
    );
  });

  it("discovers memory.ts as a module source", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "memory.ts": "export default {};",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.memory).toEqual([
      {
        sourceKind: "module",
        logicalPath: "memory.ts",
        sourceId: "memory.ts",
      },
    ]);
  });

  it("emits no diagnostic and an empty memory array when no memory is authored", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: { "instructions.md": "You are a precise assistant." },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.memory).toEqual([]);
  });
});

describe("memory compile projection", () => {
  it("rejects a memory layer that declares no stores", () => {
    const definition = defineMemory({ orientation: "orient", stores: {} });

    expect(() => projectCompiledMemory(definition, MODULE_SOURCE)).toThrow(
      /declares no stores; a memory layer must mount at least one store/,
    );
  });

  it("compiles a module memory's stores to their static name/path/access shape, with orientation", () => {
    const definition = defineMemory({
      orientation: "orient",
      stores: {
        notes: { backend: new InMemoryMemoryStore() },
        facts: { backend: new InMemoryMemoryStore(), path: "f", access: "ro" },
      },
    });

    const compiled = projectCompiledMemory(definition, MODULE_SOURCE);

    expect(compiled).toMatchObject({
      name: "memory",
      logicalPath: "memory.ts",
      root: "/mnt/memory",
      orientation: "orient",
      sourceId: "memory.ts",
      sourceKind: "module",
    });
    expect(compiled.stores).toEqual([
      { name: "notes" },
      { name: "facts", path: "f", access: "ro" },
    ]);
  });

  it("rejects more than 8 stores", () => {
    const stores: Record<string, { backend: InMemoryMemoryStore }> = {};
    for (let i = 0; i < 9; i += 1) {
      stores[`s${i}`] = { backend: new InMemoryMemoryStore() };
    }
    const definition = defineMemory({ orientation: "o", stores });

    expect(() => projectCompiledMemory(definition, MODULE_SOURCE)).toThrow(/at most 8/);
  });

  it("projects a dream's static config and hasRun=false when no run override", () => {
    const definition = defineMemory({
      orientation: "orient",
      stores: { notes: { backend: new InMemoryMemoryStore() } },
      dream: {
        model: "openai/gpt-5.5",
        instructions: "keep decisions only",
        cron: "0 3 * * *",
      },
    });

    const compiled = projectCompiledMemory(definition, MODULE_SOURCE);

    expect(compiled.dream).toEqual({
      hasRun: false,
      model: "openai/gpt-5.5",
      instructions: "keep decisions only",
      cron: "0 3 * * *",
    });
  });

  it("records hasRun=true when the dream declares a run override", () => {
    const definition = defineMemory({
      orientation: "orient",
      stores: { notes: { backend: new InMemoryMemoryStore() } },
      dream: { run: async () => undefined },
    });

    const compiled = projectCompiledMemory(definition, MODULE_SOURCE);

    expect(compiled.dream).toEqual({ hasRun: true });
  });

  it("omits dream entirely when the memory declares none", () => {
    const definition = defineMemory({
      orientation: "orient",
      stores: { notes: { backend: new InMemoryMemoryStore() } },
    });

    const compiled = projectCompiledMemory(definition, MODULE_SOURCE);

    expect(compiled.dream).toBeUndefined();
  });
});
