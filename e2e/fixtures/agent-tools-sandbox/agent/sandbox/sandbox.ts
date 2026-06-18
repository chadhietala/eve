import { defineSandbox, type SandboxDefinition } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import type {
  VercelSandboxBootstrapUseOptions,
  VercelSandboxSessionUseOptions,
} from "eve/sandbox/vercel";

/**
 * Sandbox lifecycle fixture exercising the surfaces an agent author relies
 * on. The matching evals live under `evals/sandbox/` and assert each piece
 * end-to-end through a real backend.
 *
 * - `bootstrap` runs once per sandbox template. It writes a known marker
 *   file into the workspace AND installs a custom CLI (`eve-greet`) onto the
 *   PATH, the way an author would provision tooling every later session
 *   inherits. The CLI is a Python script, so it also proves the base image's
 *   real Python runtime executes bootstrap-authored code.
 * - `onSession` runs once per live session. It writes a per-session marker
 *   so an eval can prove session-scoped setup ran on top of the shared
 *   template.
 *
 * This manual smoke configuration pins the Vercel backend and injects a
 * harmless fake token into requests to Postman Echo. The echoed response
 * proves that on-request credential resolution installed the firewall
 * transform only after the awaited request demanded it.
 */
export const SANDBOX_MARKER_PATH = "/workspace/smoke-marker.txt";
export const SANDBOX_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

/**
 * Custom CLI installed during bootstrap. `/usr/local/bin` is on the default
 * PATH in the base image and is writable by the sandbox user (it is the npm
 * global prefix bin, chowned to `vercel-sandbox`), so the same install works
 * whether bootstrap runs as root (Docker) or as `vercel-sandbox` (Vercel).
 */
export const SANDBOX_CLI_PATH = "/usr/local/bin/eve-greet";
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Per-session marker written by `onSession` (live session, not the template). */
export const SANDBOX_SESSION_MARKER_PATH = "/workspace/session-marker.txt";
export const SANDBOX_SESSION_MARKER_TOKEN = "sandbox-onsession-ok-X5T";

const CLI_SCRIPT = [
  "#!/usr/bin/env python3",
  "import sys",
  'name = sys.argv[1] if len(sys.argv) > 1 else "world"',
  `print(f"${SANDBOX_CLI_TOKEN}:{name}")`,
  "",
].join("\n");

const backend = vercel({
  authProxyBaseUrl: "https://temp-test-eager-eve.vercel.app",
  credentialResolution: "on-request",
  networkPolicy: {
    allow: {
      "postman-echo.com": [
        {
          auth: defineInteractiveAuthorization({
            async getToken() {
              throw new ConnectionAuthorizationRequiredError("postman-echo");
            },
            async startAuthorization({ callbackUrl }) {
              const callback = new URL(callbackUrl);
              callback.searchParams.set("code", "eve-fake-code");
              return {
                challenge: {
                  displayName: "Postman Echo smoke test",
                  instructions: "Open the link to grant the sandbox its fake test token.",
                  url: callback.toString(),
                },
              };
            },
            async completeAuthorization({ callback }) {
              if (callback.params.code !== "eve-fake-code") {
                throw new ConnectionAuthorizationFailedError("postman-echo", {
                  reason: "invalid_fake_code",
                  retryable: false,
                });
              }
              return { token: "eve-fake-token" };
            },
          }),
          match: {
            method: ["GET"],
            path: { exact: "/get" },
          },
          transform: ({ token }) => [
            {
              headers: {
                "x-eve-test-token": token,
              },
            },
          ],
        },
      ],
    },
  },
});

const definition: SandboxDefinition<
  VercelSandboxBootstrapUseOptions,
  VercelSandboxSessionUseOptions
> = defineSandbox({
  backend,
  // Bump when the bootstrap output changes so the reusable template snapshot
  // is rebuilt rather than served stale.
  revalidationKey: () => "agent-tools-sandbox-bootstrap-v2",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_MARKER_PATH,
      content: SANDBOX_MARKER_TOKEN,
    });
    // Install a custom CLI onto the PATH and make it executable. Later
    // sessions inherit it from the template without re-running bootstrap.
    await sandbox.writeTextFile({ path: SANDBOX_CLI_PATH, content: CLI_SCRIPT });
    const chmod = await sandbox.run({ command: `chmod +x ${SANDBOX_CLI_PATH}` });
    if (chmod.exitCode !== 0) {
      throw new Error(`bootstrap: chmod of ${SANDBOX_CLI_PATH} failed: ${chmod.stderr}`);
    }
  },
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({
      path: SANDBOX_SESSION_MARKER_PATH,
      content: SANDBOX_SESSION_MARKER_TOKEN,
    });
  },
});

export default definition;
