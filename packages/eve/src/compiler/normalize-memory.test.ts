import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { compileMemoryEntry } from "#compiler/normalize-memory.js";

describe("memory discovery + compile", () => {
  it("discovers memory.md as an optional markdown source carrying the body as orientation", async () => {
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
        definition: { orientation: "Remember the user prefers metric units." },
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

  it("compiles a markdown memory source into orientation under the default /memory root", async () => {
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
      root: "/memory",
      orientation: "Remember the user prefers metric units.",
      hasStore: false,
      handlerNames: [],
      sourceId: "memory.md",
      sourceKind: "markdown",
    });
  });
});
