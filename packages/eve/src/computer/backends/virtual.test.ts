import { describe, expect, it } from "vitest";

import { virtualComputer } from "#computer/backends/virtual.js";

const context = { abortSignal: new AbortController().signal };

describe("virtualComputer", () => {
  it("reports its screen size and renders a PNG screenshot", async () => {
    const computer = virtualComputer({ height: 200, title: "eve desktop", width: 320 });

    expect(await computer.execute({ action: "screen_size" }, context)).toEqual({
      screen: { height: 200, width: 320 },
    });

    const { screenshot } = await computer.execute({ action: "screenshot" }, context);
    expect(screenshot).toMatchObject({ height: 200, mediaType: "image/png", width: 320 });
    expect(Buffer.from(screenshot!.base64, "base64").subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
  });

  it("tracks the cursor across moves and clicks", async () => {
    const computer = virtualComputer({ height: 200, width: 320 });

    await computer.execute({ action: "mouse_move", coordinate: [10, 20] }, context);
    expect(await computer.execute({ action: "cursor_position" }, context)).toEqual({
      cursor: { x: 10, y: 20 },
    });

    await computer.execute({ action: "left_click", coordinate: [30, 40] }, context);
    expect(computer.cursor).toEqual({ x: 30, y: 40 });
  });

  it("activates the element under a click", async () => {
    const activations: string[] = [];
    const computer = virtualComputer({
      elements: [
        {
          bounds: [10, 10, 100, 40],
          id: "send",
          label: "SEND",
          onActivate: ({ point }) => activations.push(`send@${point.x},${point.y}`),
        },
        { bounds: [10, 60, 100, 40], id: "quiet", label: "QUIET" },
      ],
      height: 200,
      width: 320,
    });

    await computer.execute({ action: "left_click", coordinate: [20, 20] }, context);
    await computer.execute({ action: "left_click", coordinate: [20, 70] }, context);
    await computer.execute({ action: "left_click", coordinate: [300, 190] }, context);

    expect(activations).toEqual(["send@20,20"]);
  });

  it("records typed text and key chords", async () => {
    const computer = virtualComputer();

    await computer.execute({ action: "type", text: "hello " }, context);
    await computer.execute({ action: "type", text: "world" }, context);
    await computer.execute({ action: "key", keys: "ctrl+s" }, context);

    expect(computer.typed).toBe("hello world");
    expect(computer.keys).toEqual(["ctrl+s"]);
    expect(computer.actions.map((action) => action.action)).toEqual(["type", "type", "key"]);
  });

  it("rejects a coordinate outside the screen with a recoverable message", async () => {
    const computer = virtualComputer({ height: 100, width: 100 });

    await expect(
      computer.execute({ action: "mouse_move", coordinate: [100, 10] }, context),
    ).rejects.toThrow(/outside the 100x100 screen/);
  });

  it("drags from an explicit origin to a destination", async () => {
    const computer = virtualComputer();

    await computer.execute({ action: "left_click_drag", from: [5, 5], to: [50, 60] }, context);

    expect(computer.cursor).toEqual({ x: 50, y: 60 });
  });
});
