import type { ComputerActionResult } from "#computer/action.js";
import type { ComputerBackend } from "#computer/backend.js";
import { ComputerError, defineComputerBackend } from "#computer/backend.js";
import { COMPUTER_EXECUTE_PATH, COMPUTER_RESPONSE_SCHEMA } from "#computer/protocol.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RemoteComputerOptions {
  /**
   * Base URL of a computer host, e.g. the eve desktop app's control server.
   * Must be `https:`, or `http:` on a loopback address.
   */
  readonly url: string;
  /** Shared secret sent as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Per-action timeout. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Drives a machine that runs a computer host. This is how an agent deployed
 * anywhere controls the desktop a person is sitting in front of.
 */
export function remoteComputer(options: RemoteComputerOptions): ComputerBackend {
  const endpoint = resolveEndpoint(options.url);
  const token = options.token.trim();
  if (token.length === 0) {
    throw new TypeError("remoteComputer() requires the host token.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("remoteComputer() timeoutMs must be a positive integer.");
  }

  return defineComputerBackend({
    id: "remote",
    async execute(action, context): Promise<ComputerActionResult> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(endpoint, {
        body: JSON.stringify({ action }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.any([context.abortSignal, timeout]),
      }).catch((error: unknown) => {
        throw new ComputerError(
          "unavailable",
          `Could not reach the computer host at ${endpoint.origin}. Confirm the desktop app is running and its control server is reachable.`,
          { cause: error },
        );
      });

      const payload = COMPUTER_RESPONSE_SCHEMA.safeParse(await response.json().catch(() => null));
      if (!payload.success) {
        throw new ComputerError(
          "failed",
          `Computer host at ${endpoint.origin} returned an unrecognized response (HTTP ${response.status}).`,
        );
      }
      if (!payload.data.ok) {
        throw new ComputerError(payload.data.error.reason, payload.data.error.message);
      }
      return payload.data.result;
    },
  });
}

function resolveEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`remoteComputer() url must be an absolute URL, received "${value}".`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError(
      `remoteComputer() url must use https:, or http: on a loopback host. Received "${url.protocol}//${url.hostname}".`,
    );
  }
  return new URL(`${url.pathname.replace(/\/+$/, "")}${COMPUTER_EXECUTE_PATH}${url.search}`, url);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
