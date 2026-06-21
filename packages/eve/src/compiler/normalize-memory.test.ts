import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { compileMemoryEntry } from "#compiler/normalize-memory.js";
import { defineMemory } from "#public/definitions/memory.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemorySourceRef } from "#discover/manifest.js";

describe("memory discovery + compile", () => {
  it("discovers memory.md as an optional markdown source carrying the body as orientation and no stores", async () => {
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

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.memory).toEqual([
      {
        definition: { stores: {}, orientation: "Remember the user prefers metric units." },
        sourceKind: "markdown",
        logicalPath: "memory.md",
        sourceId: "memory.md",
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

  it("compiles a markdown memory source to orientation-only with no stores under /mnt/memory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "memory.md": "Remember the user prefers metric units.",
      },
    });

    const { manifest } = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    const source = manifest.memory[0];
    expect(source).toBeDefined();
    const compiled = await compileMemoryEntry(manifest.agentRoot, source!);

    expect(compiled).toEqual({
      name: "memory",
      logicalPath: "memory.md",
      root: "/mnt/memory",
      orientation: "Remember the user prefers metric units.",
      stores: [],
      sourceId: "memory.md",
      sourceKind: "markdown",
    });
  });

  it("compiles a module memory's stores to their static name/path/access shape", async () => {
    const source: MemorySourceRef = {
      sourceKind: "module",
      logicalPath: "memory.ts",
      sourceId: "memory.ts",
      exportName: undefined,
    };
    // The module-backed compile reads the live export from the module loader; the
    // discovery-free path resolves the definition via the source's project loader.
    // Here we project directly against an in-memory defineMemory instead.
    const definition = defineMemory({
      orientation: "orient",
      stores: {
        notes: { backend: new InMemoryMemoryStore() },
        facts: { backend: new InMemoryMemoryStore(), path: "f", access: "ro" },
      },
    });

    const compiled = await compileMemoryEntry("/mnt/memory/app", {
      ...source,
      // Inline-module form: the loader returns the branded definition.
      // We exercise projectCompiledStores through the markdown branch by faking a
      // markdown source whose definition is the module definition.
      sourceKind: "markdown",
      definition,
    });

    expect(compiled.stores).toEqual([
      { name: "notes" },
      { name: "facts", path: "f", access: "ro" },
    ]);
  });

  it("rejects more than 8 stores at compile time", async () => {
    const stores: Record<string, { backend: InMemoryMemoryStore }> = {};
    for (let i = 0; i < 9; i += 1) {
      stores[`s${i}`] = { backend: new InMemoryMemoryStore() };
    }
    const source: MemorySourceRef = {
      sourceKind: "markdown",
      logicalPath: "memory.ts",
      sourceId: "memory.ts",
      definition: defineMemory({ orientation: "o", stores }),
    };

    await expect(compileMemoryEntry("/mnt/memory/app", source)).rejects.toThrow(/at most 8/);
  });

  it("projects a dream's static config and hasRun=false when no run override", async () => {
    const source: MemorySourceRef = {
      sourceKind: "markdown",
      logicalPath: "memory.md",
      sourceId: "memory.md",
      definition: defineMemory({
        orientation: "orient",
        stores: {},
        dream: {
          model: "openai/gpt-5.5",
          instructions: "keep decisions only",
          schedule: { idleMs: 60_000, cron: "0 3 * * *", minSessions: 3 },
        },
      }),
    };

    const compiled = await compileMemoryEntry("/mnt/memory/app", source);

    expect(compiled.dream).toEqual({
      hasRun: false,
      model: "openai/gpt-5.5",
      instructions: "keep decisions only",
      schedule: { idleMs: 60_000, cron: "0 3 * * *", minSessions: 3 },
    });
  });

  it("records hasRun=true when the dream declares a run override", async () => {
    const source: MemorySourceRef = {
      sourceKind: "markdown",
      logicalPath: "memory.md",
      sourceId: "memory.md",
      definition: defineMemory({
        orientation: "orient",
        stores: {},
        dream: { run: async () => undefined },
      }),
    };

    const compiled = await compileMemoryEntry("/mnt/memory/app", source);

    expect(compiled.dream).toEqual({ hasRun: true });
  });

  it("omits dream entirely when the memory declares none", async () => {
    const source: MemorySourceRef = {
      sourceKind: "markdown",
      logicalPath: "memory.md",
      sourceId: "memory.md",
      definition: defineMemory({ orientation: "orient", stores: {} }),
    };

    const compiled = await compileMemoryEntry("/mnt/memory/app", source);

    expect(compiled.dream).toBeUndefined();
  });
});
