import { describe, expect, it } from "vitest";

import { virtualComputer } from "#computer/backends/virtual.js";
import { COMPUTER_INPUT_SCHEMA, computer } from "#tools/provided/computer.js";

const context = { abortSignal: new AbortController().signal } as never;

describe("computer tool", () => {
  it("executes an action against its backend and echoes the action name", async () => {
    const backend = virtualComputer({ height: 100, width: 200 });
    const definition = computer({ backend });

    const output = await definition.execute({ action: "type", text: "hello" }, context);

    expect(output).toEqual({ action: "type", text: "Typed 5 characters." });
    expect(backend.typed).toBe("hello");
  });

  it("hands the model the screenshot as an image part alongside the summary", async () => {
    const definition = computer({ backend: virtualComputer({ height: 100, width: 200 }) });

    const output = (await definition.execute({ action: "screenshot" }, context)) as never;
    const modelOutput = await definition.toModelOutput!(output);

    expect(modelOutput.type).toBe("content");
    const parts = (modelOutput as { value: readonly Record<string, unknown>[] }).value;
    expect(parts[0]).toEqual({
      type: "text",
      text: "Screenshot of the 200x100 screen:",
    });
    expect(parts[1]).toMatchObject({ type: "file", mediaType: "image/png" });
  });

  it("describes the cursor and screen without a screenshot", async () => {
    const definition = computer({ backend: virtualComputer({ height: 100, width: 200 }) });

    const size = (await definition.execute({ action: "screen_size" }, context)) as never;
    const cursor = (await definition.execute({ action: "cursor_position" }, context)) as never;

    expect(await definition.toModelOutput!(size)).toEqual({
      type: "content",
      value: [{ type: "text", text: "Screen is 200x100 pixels." }],
    });
    expect(await definition.toModelOutput!(cursor)).toEqual({
      type: "content",
      value: [{ type: "text", text: "Cursor is at (100, 50)." }],
    });
  });

  it("validates actions through the shared schema", () => {
    const schema = COMPUTER_INPUT_SCHEMA;

    expect(computer({ backend: virtualComputer() }).inputSchema).toBe(schema);
    expect(schema.safeParse({ action: "scroll", direction: "down", amount: 3 }).success).toBe(true);
    expect(schema.safeParse({ action: "scroll", direction: "sideways", amount: 3 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ action: "type", text: "x".repeat(4_097) }).success).toBe(false);
    expect(schema.safeParse({ action: "wait", durationMs: 60_000 }).success).toBe(false);
  });

  it("asks for approval once per session by default", () => {
    expect(computer({ backend: virtualComputer() }).approval).toBeDefined();
  });
});
