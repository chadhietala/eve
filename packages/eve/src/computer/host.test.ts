import { describe, expect, it } from "vitest";

import { virtualComputer } from "#computer/backends/virtual.js";
import { ComputerError } from "#computer/backend.js";
import { createComputerHost } from "#computer/host.js";

const TOKEN = "0123456789abcdef0123";

function post(body: unknown, init: { readonly token?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = "token" in init ? init.token : TOKEN;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request("http://127.0.0.1:7373/v1/execute", {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

describe("createComputerHost", () => {
  it("requires a token long enough to be a secret", () => {
    expect(() => createComputerHost({ backend: virtualComputer(), token: "short" })).toThrow(
      /at least 16 characters/,
    );
  });

  it("executes an action and returns its result", async () => {
    const handle = createComputerHost({ backend: virtualComputer(), token: TOKEN });

    const response = await handle(post({ action: { action: "screen_size" } }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: { screen: { height: 640, width: 1_024 } },
    });
  });

  it("reports the backend identity and screen from the info route", async () => {
    const handle = createComputerHost({ backend: virtualComputer(), token: TOKEN });

    const response = await handle(
      new Request("http://127.0.0.1:7373/v1/info", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      id: "virtual",
      screen: { height: 640, width: 1_024 },
    });
  });

  it("rejects a missing or wrong token before touching the backend", async () => {
    let executed = 0;
    const handle = createComputerHost({
      backend: {
        id: "counting",
        async execute() {
          executed += 1;
          return {};
        },
      },
      token: TOKEN,
    });

    const anonymous = await handle(
      post({ action: { action: "screenshot" } }, { token: undefined }),
    );
    const wrong = await handle(
      post({ action: { action: "screenshot" } }, { token: "wrong-token-value" }),
    );

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(executed).toBe(0);
  });

  it("rejects an unknown action with the validation message", async () => {
    const handle = createComputerHost({ backend: virtualComputer(), token: TOKEN });

    const response = await handle(post({ action: { action: "format_disk" } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { reason: "invalid" },
    });
  });

  it("bounds the request body", async () => {
    const handle = createComputerHost({ backend: virtualComputer(), token: TOKEN });

    const response = await handle(post({ action: { action: "type", text: "x".repeat(70_000) } }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("exceeds") },
    });
  });

  it("forwards a backend error reason as its HTTP status", async () => {
    const handle = createComputerHost({
      backend: {
        id: "broken",
        execute() {
          return Promise.reject(new ComputerError("unsupported", "`xdotool` is not installed."));
        },
      },
      token: TOKEN,
    });

    const response = await handle(post({ action: { action: "screenshot" } }));

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { message: "`xdotool` is not installed.", reason: "unsupported" },
    });
  });

  it("rejects an unknown route", async () => {
    const handle = createComputerHost({ backend: virtualComputer(), token: TOKEN });

    const response = await handle(
      new Request("http://127.0.0.1:7373/v1/anything", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    expect(response.status).toBe(400);
  });
});
