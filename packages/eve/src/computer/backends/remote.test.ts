import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerError } from "#computer/backend.js";
import { remoteComputer } from "#computer/backends/remote.js";
import { virtualComputer } from "#computer/backends/virtual.js";
import { createComputerHost } from "#computer/host.js";

const TOKEN = "0123456789abcdef0123";
const context = { abortSignal: new AbortController().signal };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Wires the client straight into a host handler, skipping the socket. */
function connect(handle: (request: Request) => Promise<Response>) {
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) =>
    handle(new Request(input, init)),
  );
}

describe("remoteComputer", () => {
  it("round-trips an action through a computer host", async () => {
    const backend = virtualComputer({ height: 100, width: 200 });
    connect(createComputerHost({ backend, token: TOKEN }));
    const remote = remoteComputer({ token: TOKEN, url: "http://127.0.0.1:7373" });

    await remote.execute({ action: "type", text: "hi" }, context);

    expect(await remote.execute({ action: "screen_size" }, context)).toEqual({
      screen: { height: 100, width: 200 },
    });
    expect(backend.typed).toBe("hi");
  });

  it("surfaces a host error with its reason", async () => {
    connect(createComputerHost({ backend: virtualComputer(), token: TOKEN }));
    const remote = remoteComputer({ token: "wrong-token-value", url: "https://desk.example.com" });

    const error = await remote.execute({ action: "screenshot" }, context).catch((cause) => cause);

    expect(ComputerError.is(error)).toBe(true);
    expect((error as ComputerError).reason).toBe("unauthorized");
  });

  it("explains an unreachable host", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    const remote = remoteComputer({ token: TOKEN, url: "http://localhost:7373" });

    const error = await remote.execute({ action: "screenshot" }, context).catch((cause) => cause);

    expect((error as ComputerError).reason).toBe("unavailable");
    expect((error as Error).message).toMatch(/Confirm the desktop app is running/);
  });

  it("requires https off loopback so the token is never sent in the clear", () => {
    expect(() => remoteComputer({ token: TOKEN, url: "http://desk.example.com" })).toThrow(
      /must use https:/,
    );
    expect(() => remoteComputer({ token: TOKEN, url: "http://127.0.0.1:7373" })).not.toThrow();
    expect(() => remoteComputer({ token: TOKEN, url: "https://desk.example.com" })).not.toThrow();
  });

  it("appends the execute path to a base URL that already has one", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (input: URL | string) => {
      seen.push(String(input));
      return Promise.resolve(Response.json({ ok: true, result: {} }));
    });

    await remoteComputer({ token: TOKEN, url: "https://desk.example.com/computer/" }).execute(
      { action: "screenshot" },
      context,
    );

    expect(seen).toEqual(["https://desk.example.com/computer/v1/execute"]);
  });
});
