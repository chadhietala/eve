import { describe, expect, it } from "vitest";

import type { DynamicResolveContext } from "#dynamic/definition.js";

import { inMemory } from "#public/memory/file/backends/in-memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { createRecord } from "#public/memory/learning/record.js";
import { createLearningStore } from "#public/memory/learning/store.js";
import { withStatus } from "#public/self-improvement/directive.js";
import { learnedDirectives } from "#public/self-improvement/instructions.js";
import { DEFAULT_DIRECTIVE_KEY } from "#public/self-improvement/provider.js";

const signal = new AbortController().signal;

async function seed(backend: MemoryDocumentBackend, texts: readonly string[]): Promise<void> {
  await createLearningStore({ backend }).update({
    key: DEFAULT_DIRECTIVE_KEY,
    mutate: () =>
      texts.map((text, index) =>
        withStatus(createRecord({ kind: "directive", text }, Date.now(), `d${index}`), "active"),
      ),
    now: Date.now(),
    signal,
  });
}

async function resolve(backend: MemoryDocumentBackend) {
  const resolver = learnedDirectives({ backend }).events["session.started"];
  return resolver?.({}, {} as DynamicResolveContext) ?? null;
}

describe("learnedDirectives", () => {
  it("contributes nothing when the agent has learned nothing", async () => {
    expect(await resolve(inMemory())).toBeNull();
  });

  it("contributes active directives as instructions", async () => {
    const backend = inMemory();
    await seed(backend, ["Run the migration check before deploying."]);

    const instructions = await resolve(backend);

    expect(instructions?.content).toContain("## Learned operating notes");
    expect(instructions?.content).toContain("- Run the migration check before deploying.");
  });

  it("resolves only at session start, so an activation never changes a live conversation", () => {
    expect(Object.keys(learnedDirectives().events)).toEqual(["session.started"]);
  });
});
