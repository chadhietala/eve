import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import {
  COMPUTER_ACTION_SCHEMA,
  ComputerError,
  createComputerHost,
  defaultComputerBackend,
  type ComputerBackend,
} from "eve/computer";

import { virtualDesktop } from "./virtual-desktop.js";
import {
  loadConfig,
  normalizeBotInput,
  saveConfig,
  toPublicBot,
  type BotConfig,
  type DesktopConfig,
} from "./config.js";

const MAX_BODY_BYTES = 256 * 1_024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export interface DesktopServerOptions {
  /** Machine the desktop exposes to agents. Defaults to this machine. */
  readonly backend?: ComputerBackend;
  /**
   * Interface to bind. Defaults to loopback: the control server is full
   * control of this machine, so reaching it from a phone is an explicit
   * choice, not a default.
   */
  readonly host?: string;
  readonly port?: number;
  /** Directory holding the built renderer. */
  readonly rendererRoot?: string;
}

export interface DesktopServer {
  readonly close: () => Promise<void>;
  readonly config: DesktopConfig;
  /** URL a phone can open, including the pairing token. */
  readonly pairingUrl: (hostname: string) => string;
  readonly port: number;
  readonly server: Server;
}

export async function startDesktopServer(
  options: DesktopServerOptions = {},
): Promise<DesktopServer> {
  let config = await loadConfig();
  // A simulated screen keeps the app usable where there is no display, which
  // is also how its UI is exercised in tests.
  const backend =
    options.backend ??
    (process.env.EVE_DESKTOP_COMPUTER === "virtual" ? virtualDesktop() : defaultComputerBackend());
  const rendererRoot = resolve(
    options.rendererRoot ?? new URL("../renderer/", import.meta.url).pathname,
  );
  const computerHost = createComputerHost({ backend, token: config.controlToken });
  const expectedToken = Buffer.from(config.controlToken, "utf8");

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // The message may name a local path or a bot's host, so it stays on the
      // server; the client gets the status only.
      console.error("[eve-desktop] request failed:", error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Request failed." }));
    });
  });

  const port = await listen(server, options.port ?? 7373, options.host ?? "127.0.0.1");

  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
    get config() {
      return config;
    },
    pairingUrl: (hostname) =>
      `http://${hostname}:${port}/?t=${encodeURIComponent(config.controlToken)}`,
    port,
    server,
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;

    // The computer host authenticates itself: agents present the token as a
    // bearer, never as a browser session.
    if (path.startsWith("/computer/")) {
      const hostResponse = await computerHost(await toWebRequest(request, url));
      await writeWebResponse(response, hostResponse);
      return;
    }

    if (!authorize(request, url, response)) {
      json(response, 401, { error: "Pair this device from the desktop app first." });
      return;
    }

    if (path.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveRenderer(response, path);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname;

    if (path === "/api/state" && request.method === "GET") {
      json(response, 200, {
        bots: config.bots.map(toPublicBot),
        computer: { backend: backend.id },
      });
      return;
    }

    if (path === "/api/bots" && request.method === "POST") {
      const fields = validate(response, await readJson(request));
      if (fields === null) return;
      const bot: BotConfig = { ...fields, id: nextBotId() };
      config = { ...config, bots: [...config.bots, bot] };
      await saveConfig(config);
      json(response, 201, { bot: toPublicBot(bot) });
      return;
    }

    const botMatch = /^\/api\/bots\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(path);
    if (botMatch !== null) {
      const bot = config.bots.find((entry) => entry.id === botMatch[1]);
      if (bot === undefined) {
        json(response, 404, { error: "No such bot." });
        return;
      }
      const rest = botMatch[2] ?? "";

      if (rest === "" && request.method === "PATCH") {
        const fields = validate(response, { ...toPublicBot(bot), ...(await readJson(request)) });
        if (fields === null) return;
        const updated: BotConfig = { ...bot, ...fields, id: bot.id };
        config = {
          ...config,
          bots: config.bots.map((entry) => (entry.id === bot.id ? updated : entry)),
        };
        await saveConfig(config);
        json(response, 200, { bot: toPublicBot(updated) });
        return;
      }

      if (rest === "" && request.method === "DELETE") {
        config = { ...config, bots: config.bots.filter((entry) => entry.id !== bot.id) };
        await saveConfig(config);
        json(response, 200, { deleted: bot.id });
        return;
      }

      if (rest.startsWith("/eve/")) {
        await proxyToAgent(request, response, bot, `${rest}${url.search}`);
        return;
      }
    }

    if (path === "/api/computer/screenshot" && request.method === "GET") {
      await runComputerAction(response, { action: "screenshot" });
      return;
    }

    if (path === "/api/computer/action" && request.method === "POST") {
      const parsed = COMPUTER_ACTION_SCHEMA.safeParse(await readJson(request));
      if (!parsed.success) {
        json(response, 400, { error: "Unrecognized computer action." });
        return;
      }
      await runComputerAction(response, parsed.data);
      return;
    }

    if (path === "/api/pairing" && request.method === "GET") {
      json(response, 200, { token: config.controlToken });
      return;
    }

    json(response, 404, { error: "No such route." });
  }

  async function runComputerAction(
    response: ServerResponse,
    action: Parameters<ComputerBackend["execute"]>[0],
  ): Promise<void> {
    try {
      const result = await backend.execute(action, { abortSignal: AbortSignal.timeout(20_000) });
      json(response, 200, result);
    } catch (error) {
      // A computer failure is almost always something only the person at this
      // machine can fix, and they are the one looking at this UI.
      const message = ComputerError.is(error) ? error.message : "The computer did not respond.";
      json(response, 503, { error: message });
    }
  }

  async function proxyToAgent(
    request: IncomingMessage,
    response: ServerResponse,
    bot: BotConfig,
    path: string,
  ): Promise<void> {
    const target = new URL(`${new URL(bot.url).pathname.replace(/\/+$/, "")}${path}`, bot.url);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value !== "string") continue;
      if (FORWARDED_HEADERS.has(name)) headers.set(name, value);
    }
    if (bot.token !== undefined && bot.token.length > 0) {
      headers.set("authorization", `Bearer ${bot.token}`);
    }

    const upstream = await fetch(target, {
      body: methodHasBody(request.method) ? toBodyInit(await readBuffer(request)) : undefined,
      headers,
      method: request.method ?? "GET",
      redirect: "manual",
    }).catch((error: unknown) => {
      console.error(`[eve-desktop] ${bot.id} unreachable:`, error);
      return null;
    });

    if (upstream === null) {
      json(response, 502, { error: `Could not reach ${bot.name}.` });
      return;
    }
    await writeWebResponse(response, upstream);
  }

  async function serveRenderer(response: ServerResponse, path: string): Promise<void> {
    const requested = path === "/" ? "/index.html" : path;
    const target = join(rendererRoot, normalize(requested).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(rendererRoot)) {
      json(response, 403, { error: "Forbidden." });
      return;
    }

    const file = await readFile(target).catch(() => null);
    if (file === null) {
      // Any unknown path is a client route; the app resolves it.
      const index = await readFile(join(rendererRoot, "index.html")).catch(() => null);
      if (index === null) {
        json(response, 404, { error: "The desktop renderer is not built. Run `pnpm build`." });
        return;
      }
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"]! });
      response.end(index);
      return;
    }

    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
    });
    response.end(file);
  }

  function authorize(request: IncomingMessage, url: URL, response: ServerResponse): boolean {
    const presented =
      url.searchParams.get("t") ??
      bearer(request.headers.authorization) ??
      cookie(request.headers.cookie, "eve_desktop");
    if (presented === null || !matchesToken(presented, expectedToken)) return false;

    // Pairing arrives in the URL once; the cookie carries it afterwards so the
    // token stops appearing in link previews and history.
    if (url.searchParams.get("t") !== null) {
      response.setHeader(
        "set-cookie",
        `eve_desktop=${presented}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
      );
    }
    return true;
  }

  /**
   * A malformed bot is the person's typo, not a server fault, so its message
   * goes back with a 400 rather than becoming an opaque 500.
   */
  function validate(response: ServerResponse, input: unknown): Omit<BotConfig, "id"> | null {
    try {
      return normalizeBotInput(input);
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : "That bot is not valid.",
      });
      return null;
    }
  }

  function nextBotId(): string {
    for (let attempt = 0; ; attempt += 1) {
      const id = `bot-${(Date.now() + attempt).toString(36)}`;
      if (!config.bots.some((bot) => bot.id === id)) return id;
    }
  }
}

const FORWARDED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-type",
  "last-event-id",
]);

function methodHasBody(method: string | undefined): boolean {
  return method !== undefined && method !== "GET" && method !== "HEAD";
}

function matchesToken(presented: string, expected: Buffer): boolean {
  const candidate = Buffer.from(presented, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer (.+)$/.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}

function cookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/**
 * Node buffers and the fetch body type disagree about their backing store, so
 * a request body is copied into a plain `ArrayBuffer` on its way out. Bodies
 * are capped at 256 KiB, which makes the copy free in practice.
 */
function toBodyInit(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

async function readBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBuffer(request);
  if (body.length === 0) return {};
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function toWebRequest(request: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const init: RequestInit = { headers, method: request.method ?? "GET" };
  if (methodHasBody(request.method)) init.body = toBodyInit(await readBuffer(request));
  return new Request(url, init);
}

async function writeWebResponse(response: ServerResponse, source: Response): Promise<void> {
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    if (name !== "content-encoding" && name !== "content-length") headers[name] = value;
  });
  response.writeHead(source.status, headers);

  if (source.body === null) {
    response.end();
    return;
  }
  // Streamed so a long agent turn reaches the UI as it happens.
  for await (const chunk of source.body) response.write(chunk);
  response.end();
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("The desktop server did not bind a port."));
        return;
      }
      resolvePort(address.port);
    });
  });
}
