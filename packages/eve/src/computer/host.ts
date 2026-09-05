import { timingSafeEqual } from "node:crypto";

import type { ComputerBackend } from "#computer/backend.js";
import { ComputerError } from "#computer/backend.js";
import {
  COMPUTER_ERROR_STATUS,
  COMPUTER_EXECUTE_PATH,
  COMPUTER_INFO_PATH,
  COMPUTER_REQUEST_SCHEMA,
  MAX_REQUEST_BYTES,
} from "#computer/protocol.js";

export interface ComputerHostOptions {
  /**
   * Backend the host drives. Every request reaches exactly this machine, so
   * the caller decides whether that is a virtual screen, the local display,
   * or a sandbox.
   */
  readonly backend: ComputerBackend;
  /**
   * Shared secret required in `Authorization: Bearer <token>`. Required: a
   * host exposes full control of a machine, so there is no unauthenticated
   * mode to fall into by accident.
   */
  readonly token: string;
}

/**
 * A `Request` handler exposing one {@link ComputerBackend} over the eve
 * computer protocol. Mount it in the desktop app, a dev server, or any
 * runtime with `fetch` types so an agent can drive that machine remotely.
 */
export function createComputerHost(
  options: ComputerHostOptions,
): (request: Request) => Promise<Response> {
  const { backend } = options;
  const token = options.token.trim();
  if (token.length < 16) {
    throw new TypeError(
      "createComputerHost() token must be at least 16 characters. Generate one with `crypto.randomUUID()` and keep it out of source control.",
    );
  }
  const expected = Buffer.from(token, "utf8");

  return async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");

    if (!authorized(request, expected)) {
      return errorResponse("unauthorized", "Missing or invalid computer host token.");
    }

    if (request.method === "GET" && path.endsWith(COMPUTER_INFO_PATH)) {
      try {
        const result = await backend.execute(
          { action: "screen_size" },
          { abortSignal: request.signal },
        );
        return Response.json({ id: backend.id, screen: result.screen });
      } catch (error) {
        return fromError(error);
      }
    }

    if (request.method !== "POST" || !path.endsWith(COMPUTER_EXECUTE_PATH)) {
      return errorResponse(
        "invalid",
        `Unknown computer host route. Use GET ${COMPUTER_INFO_PATH} or POST ${COMPUTER_EXECUTE_PATH}.`,
      );
    }

    const body = await readBoundedText(request);
    if (body === null) {
      return errorResponse(
        "invalid",
        `Computer host request body exceeds the ${MAX_REQUEST_BYTES}-byte limit.`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return errorResponse("invalid", "Computer host request body must be JSON.");
    }

    const parsed = COMPUTER_REQUEST_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return errorResponse("invalid", `Invalid computer action: ${parsed.error.message}`);
    }

    try {
      const result = await backend.execute(parsed.data.action, { abortSignal: request.signal });
      return Response.json({ ok: true, result });
    } catch (error) {
      return fromError(error);
    }
  };
}

function authorized(request: Request, expected: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null) return false;
  const presented = Buffer.from(match[1]!, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

async function readBoundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  const body = await request.text();
  return Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES ? null : body;
}

function fromError(error: unknown): Response {
  if (ComputerError.is(error)) return errorResponse(error.reason, error.message);
  // The message describes what the local machine could not do, and the host
  // is operator-owned, so forwarding it helps the agent recover.
  return errorResponse(
    "failed",
    error instanceof Error ? error.message : "Computer action failed.",
  );
}

function errorResponse(reason: keyof typeof COMPUTER_ERROR_STATUS, message: string): Response {
  return Response.json(
    { ok: false, error: { message, reason } },
    { status: COMPUTER_ERROR_STATUS[reason] },
  );
}
