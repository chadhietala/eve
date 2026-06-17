import type {
  Sandbox as SdkSandbox,
  SandboxCommand as SdkSandboxCommand,
} from "#compiled/@vercel/sandbox/index.js";

import type { VercelCredentialBrokering } from "#execution/sandbox/bindings/vercel-credentials.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";
import type { VercelSandboxSessionUseOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export function createVercelSandboxHandle(
  sandbox: SdkSandbox,
  sessionKey: string,
  brokering: VercelCredentialBrokering | undefined,
  brokeredPolicy: SandboxNetworkPolicy | undefined,
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey),
      createVercelNetworkPolicySetter(sandbox),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        await sandbox.update(options);
      }
      if (brokeredPolicy !== undefined) {
        await sandbox.update({ networkPolicy: brokeredPolicy });
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey),
        createVercelNetworkPolicySetter(sandbox),
      );
    },
    async captureState() {
      return {
        backendName: "vercel",
        metadata: { sandboxName: sandbox.name },
        sessionKey,
      };
    },
    async dispose() {
      if (brokering !== undefined) {
        await sandbox.update({ networkPolicy: brokering.emptyPolicy });
      }
    },
  };
}

export function createVercelInternalSandboxSession(
  sandbox: SdkSandbox,
  id: string,
): InternalSandboxSession {
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      return adaptVercelCommandToSandboxProcess(command);
    },
    async readFile(options: SandboxReadFileOptions) {
      const stream = await sandbox.readFile({ path: options.path });
      return stream ?? null;
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

export function createVercelNetworkPolicySetter(
  sandbox: SdkSandbox,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    await sandbox.update({ networkPolicy: policy });
  };
}

/**
 * Wraps a Vercel `Command` (returned from `runCommand({ detached: true })`)
 * in the AI SDK `Experimental_SandboxProcess` shape.
 */
function adaptVercelCommandToSandboxProcess(command: SdkSandboxCommand): SandboxProcess {
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamingDone = false;
  let streamingError: unknown;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  void (async () => {
    try {
      for await (const message of command.logs()) {
        const chunk = encoder.encode(message.data);
        if (message.stream === "stdout") {
          stdoutController?.enqueue(chunk);
        } else {
          stderrController?.enqueue(chunk);
        }
      }
    } catch (error) {
      streamingError = error;
      stdoutController?.error(error);
      stderrController?.error(error);
    } finally {
      streamingDone = true;
      if (streamingError === undefined) {
        stdoutController?.close();
        stderrController?.close();
      }
    }
  })();

  return {
    stdout,
    stderr,
    async wait() {
      const finished = await command.wait();
      while (!streamingDone) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (streamingError !== undefined) {
        throw streamingError;
      }
      return { exitCode: finished.exitCode };
    },
    async kill() {
      await command.kill();
    },
  };
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
