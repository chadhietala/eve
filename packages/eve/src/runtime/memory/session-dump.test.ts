import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  dumpSession,
  formatTranscriptJsonl,
  transcriptPath,
} from "#runtime/memory/session-dump.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const NS: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "scope-1",
  scopeType: "working",
};

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

describe("formatTranscriptJsonl", () => {
  it("emits one JSON object per message, parseable and order-preserving", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "general kenobi" },
    ];

    const lines = formatTranscriptJsonl(messages).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ role: "user", content: "hello there" });
    expect(JSON.parse(lines[1]!)).toEqual({ role: "assistant", content: "general kenobi" });
  });

  it("preserves full fidelity of tool-call/tool-result content (no lossy placeholders)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ];

    const lines = formatTranscriptJsonl(messages).split("\n");
    const assistant = JSON.parse(lines[0]!);
    // The tool call and its arguments survive verbatim — this is the point of JSONL.
    expect(assistant.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "search",
      input: { q: "x" },
    });
    const tool = JSON.parse(lines[1]!);
    expect(tool.content[0]).toMatchObject({ type: "tool-result", toolName: "search" });
  });

  it("returns an empty string for no messages", () => {
    expect(formatTranscriptJsonl([])).toBe("");
  });
});

describe("transcriptPath", () => {
  it("places the transcript under sessions/<id>/transcript.jsonl", () => {
    expect(transcriptPath("abc")).toBe("sessions/abc/transcript.jsonl");
  });

  it("sanitizes a traversal id so it cannot escape sessions/", () => {
    const path = transcriptPath("../../etc/passwd");
    expect(path.startsWith("sessions/")).toBe(true);
    expect(path.endsWith("/transcript.jsonl")).toBe(true);
    expect(path).not.toContain("/etc/");
    expect(path).not.toContain("..");
  });
});

describe("dumpSession", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "remember this" }];

  it("writes the transcript to the expected path", async () => {
    const store = new InMemoryMemoryStore();
    await dumpSession(store, NS, { sessionId: "s1", messages, writeKey: "k1" });

    const stored = decode(await store.read(NS, "sessions/s1/transcript.jsonl"));
    expect(stored).toBe(formatTranscriptJsonl(messages));
  });

  it("is idempotent under the same key", async () => {
    const store = new InMemoryMemoryStore();
    await dumpSession(store, NS, { sessionId: "s1", messages, writeKey: "k1" });
    // Same key with different content is a no-op (store dedups on the key).
    await dumpSession(store, NS, {
      sessionId: "s1",
      messages: [{ role: "user", content: "changed" }],
      writeKey: "k1",
    });

    expect(decode(await store.read(NS, "sessions/s1/transcript.jsonl"))).toBe(
      formatTranscriptJsonl(messages),
    );
  });
});
