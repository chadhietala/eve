import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createBootstrapGenerateResult,
  createBootstrapToolCallResult,
} from "#runtime/agent/bootstrap-model-utils.js";
import { buildDreamSystemPrompt, runDreamAgent } from "#runtime/memory/dream-agent.js";
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

const ROOT = "/mnt/memory";
const decoder = new TextDecoder();

function mountStore(
  name: string,
  backend: InMemoryMemoryStore,
  access: "ro" | "rw" = "rw",
  description?: string,
): MountedStore {
  const mount: MountedStore = { name, backend, mountPath: `${ROOT}/${name}`, access };
  return description === undefined ? mount : { ...mount, description };
}

interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * A mock model that issues a fixed script of tool calls (one per step), then
 * stops with a final text. Records every tool name + input the agent received so
 * a test can assert what the loop did.
 */
function scriptedModel(script: ToolCall[]) {
  let step = 0;
  return new MockLanguageModelV3({
    modelId: "mock-dream-agent",
    provider: "eve-test",
    doGenerate: async () => {
      const call = script[step];
      step += 1;
      if (call === undefined) {
        return createBootstrapGenerateResult({
          inputTokens: 1,
          modelId: "mock-dream-agent",
          outputTokens: 1,
          text: "done",
        });
      }
      return createBootstrapToolCallResult({
        input: call.input,
        modelId: "mock-dream-agent",
        toolCallId: `c${step}`,
        toolName: call.toolName,
      });
    },
  });
}

const SESSIONS = [
  { sessionId: "s1", transcript: '{"role":"user","content":"I prefer metric units"}' },
];

describe("buildDreamSystemPrompt", () => {
  it("lists each writable store's mount note and description, plus instructions", () => {
    const config: MemoryConfig = {
      root: ROOT,
      stores: [
        mountStore("notes", new InMemoryMemoryStore(), "rw", "User preferences."),
        mountStore("ref", new InMemoryMemoryStore(), "ro", "Read-only reference."),
      ],
    };
    const prompt = buildDreamSystemPrompt(config, "Drop chit-chat.");

    expect(prompt).toContain("notes  →  /mnt/memory/notes — User preferences.");
    // Read-only stores are not offered as write targets.
    expect(prompt).not.toContain("/mnt/memory/ref");
    expect(prompt).toContain("Drop chit-chat.");
    expect(prompt).toContain("read_transcripts");
  });
});

describe("runDreamAgent", () => {
  it("writes the file the model chooses, routed to the right store", async () => {
    const notes = new InMemoryMemoryStore();
    const config: MemoryConfig = { root: ROOT, stores: [mountStore("notes", notes)] };

    const model = scriptedModel([
      { toolName: "read_transcripts", input: {} },
      {
        toolName: "write_file",
        input: { path: "/mnt/memory/notes/prefs.md", content: "Prefers metric units." },
      },
    ]);

    await runDreamAgent({ config, model, sessions: SESSIONS });

    const bytes = await notes.read("prefs.md");
    expect(bytes === null ? null : decoder.decode(bytes)).toBe("Prefers metric units.");
  });

  it("surfaces a read-only store write as a tool error instead of throwing", async () => {
    const ro = new InMemoryMemoryStore();
    const config: MemoryConfig = { root: ROOT, stores: [mountStore("ref", ro, "ro")] };

    const model = scriptedModel([
      { toolName: "write_file", input: { path: "/mnt/memory/ref/x.md", content: "nope" } },
    ]);

    // The loop completes (the error is returned as a tool result, not thrown).
    await expect(runDreamAgent({ config, model, sessions: SESSIONS })).resolves.toBeUndefined();
    expect(await ro.read("x.md")).toBeNull();
  });
});
