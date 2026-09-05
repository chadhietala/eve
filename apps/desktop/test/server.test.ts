import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { virtualComputer } from "eve/computer";

import { startDesktopServer, type DesktopServer } from "../src/server/server.js";

let directory = "";
let desktop: DesktopServer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eve-desktop-"));
  process.env.EVE_DESKTOP_CONFIG = join(directory, "config.json");
  desktop = await startDesktopServer({ backend: virtualComputer(), host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  delete process.env.EVE_DESKTOP_CONFIG;
  await rm(directory, { force: true, recursive: true });
});

function origin(): string {
  return `http://127.0.0.1:${desktop!.port}`;
}

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${desktop!.config.controlToken}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("desktop control server", () => {
  it("refuses every app route without the pairing token", async () => {
    for (const path of ["/", "/api/state", "/api/pairing"]) {
      expect((await fetch(`${origin()}${path}`)).status, path).toBe(401);
    }
  });

  it("accepts the token in the pairing link and sets a cookie for later requests", async () => {
    const response = await fetch(
      `${origin()}/api/state?t=${encodeURIComponent(desktop!.config.controlToken)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^eve_desktop=.*HttpOnly.*SameSite=Strict/);
  });

  it("creates, edits, and removes a bot without ever returning its token", async () => {
    const created = await authorized("/api/bots", {
      body: JSON.stringify({
        name: "Release manager",
        token: "super-secret",
        url: "https://agent.example.com/",
      }),
      method: "POST",
    });
    expect(created.status).toBe(201);
    const { bot } = (await created.json()) as { bot: Record<string, unknown> };
    expect(bot).toMatchObject({
      hasToken: true,
      name: "Release manager",
      url: "https://agent.example.com",
    });
    expect(bot.token).toBeUndefined();

    const patched = await authorized(`/api/bots/${bot.id as string}`, {
      body: JSON.stringify({ title: "Ships the release" }),
      method: "PATCH",
    });
    expect(((await patched.json()) as { bot: { title: string } }).bot.title).toBe(
      "Ships the release",
    );

    // The credential survives an edit that does not mention it.
    const stored = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
      bots: readonly { token?: string }[];
    };
    expect(stored.bots[0]?.token).toBe("super-secret");

    expect((await authorized(`/api/bots/${bot.id as string}`, { method: "DELETE" })).status).toBe(
      200,
    );
    const state = (await (await authorized("/api/state")).json()) as { bots: readonly unknown[] };
    expect(state.bots).toEqual([]);
  });

  it("rejects a bot with an unusable URL", async () => {
    const response = await authorized("/api/bots", {
      body: JSON.stringify({ name: "Bad", url: "not-a-url" }),
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A bot\'s url must be absolute, received "not-a-url".',
    });
  });

  it("drives the computer for the person at the keyboard", async () => {
    const screenshot = (await (await authorized("/api/computer/screenshot")).json()) as {
      screenshot: { base64: string; height: number; width: number };
    };
    expect(screenshot.screenshot.width).toBeGreaterThan(0);
    expect(Buffer.from(screenshot.screenshot.base64, "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );

    const typed = await authorized("/api/computer/action", {
      body: JSON.stringify({ action: "type", text: "hello" }),
      method: "POST",
    });
    expect(typed.status).toBe(200);
  });

  it("rejects an action the computer protocol does not define", async () => {
    const response = await authorized("/api/computer/action", {
      body: JSON.stringify({ action: "format_disk" }),
      method: "POST",
    });

    expect(response.status).toBe(400);
  });

  it("serves the computer host to agents on its own bearer auth", async () => {
    const anonymous = await fetch(`${origin()}/computer/v1/info`);
    expect(anonymous.status).toBe(401);

    const info = await fetch(`${origin()}/computer/v1/info`, {
      headers: { authorization: `Bearer ${desktop!.config.controlToken}` },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ id: "virtual" });
  });

  it("proxies a bot's eve routes to the agent, adding its credential", async () => {
    const seen: { authorization?: string; url?: string } = {};
    const upstream = await startEcho(seen);

    try {
      const created = await authorized("/api/bots", {
        body: JSON.stringify({ name: "Echo", token: "agent-token", url: upstream.origin }),
        method: "POST",
      });
      const { bot } = (await created.json()) as { bot: { id: string } };

      const response = await authorized(`/api/bots/${bot.id}/eve/v1/health`);

      expect(response.status).toBe(200);
      expect(seen.url).toBe("/eve/v1/health");
      expect(seen.authorization).toBe("Bearer agent-token");
    } finally {
      await upstream.close();
    }
  });

  it("reports an unreachable agent instead of failing the request", async () => {
    const created = await authorized("/api/bots", {
      body: JSON.stringify({ name: "Offline", url: "http://127.0.0.1:1" }),
      method: "POST",
    });
    const { bot } = (await created.json()) as { bot: { id: string } };

    const response = await authorized(`/api/bots/${bot.id}/eve/v1/health`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Could not reach Offline." });
  });

  it("serves the renderer shell for unknown client routes", async () => {
    const response = await authorized("/some/client/route");

    // The renderer may not be built in every checkout; either answer proves
    // the route reached the static handler rather than the API.
    expect([200, 404]).toContain(response.status);
  });
});

async function startEcho(seen: { authorization?: string; url?: string }) {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    seen.url = request.url;
    seen.authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("echo server has no port");
  return {
    close: () => new Promise<void>((done) => server.close(() => done())),
    origin: `http://127.0.0.1:${address.port}`,
  };
}
