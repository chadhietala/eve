import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { formatExchange, lastExchange, messageText } from "#public/memory/learning/transcript.js";

describe("lastExchange", () => {
  it("reads only the exchange that just settled", () => {
    const messages: readonly ModelMessage[] = [
      { content: "old question", role: "user" },
      { content: "old answer", role: "assistant" },
      { content: "new question", role: "user" },
      { content: "new answer", role: "assistant" },
    ];

    expect(lastExchange(messages)).toEqual({
      assistantText: "new answer",
      toolCalls: [],
      userText: "new question",
    });
  });

  it("pairs each tool call with whether its result was an error", () => {
    const messages: readonly ModelMessage[] = [
      { content: "do the thing", role: "user" },
      {
        content: [
          { input: {}, toolCallId: "1", toolName: "read_file", type: "tool-call" },
          { input: {}, toolCallId: "2", toolName: "bash", type: "tool-call" },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "text", value: "ok" },
            toolCallId: "1",
            toolName: "read_file",
            type: "tool-result",
          },
          {
            output: { type: "error-text", value: "boom" },
            toolCallId: "2",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "done", role: "assistant" },
    ];

    expect(lastExchange(messages).toolCalls).toEqual([
      { failed: false, name: "read_file" },
      { failed: true, name: "bash" },
    ]);
  });

  it("reads text out of multi-part content and ignores the rest", () => {
    expect(
      messageText({
        content: [
          { text: "first", type: "text" },
          { data: "…", mediaType: "image/png", type: "file" },
          { text: "second", type: "text" },
        ],
        role: "user",
      }),
    ).toBe("first\nsecond");
  });
});

describe("formatExchange", () => {
  it("renders a compact transcript and marks failures", () => {
    expect(
      formatExchange({
        assistantText: "Retried and it worked.",
        toolCalls: [{ failed: true, name: "bash" }],
        userText: "run the build",
      }),
    ).toBe("User: run the build\nTools: bash (failed)\nAssistant: Retried and it worked.");
  });

  it("truncates past the character budget", () => {
    const formatted = formatExchange(
      { assistantText: "x".repeat(500), toolCalls: [], userText: "y".repeat(500) },
      100,
    );

    expect(formatted).toHaveLength(101);
    expect(formatted.endsWith("…")).toBe(true);
  });
});
