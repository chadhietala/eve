import type {
  Sandbox as SdkSandbox,
  SandboxCommand as SdkSandboxCommand,
} from "#compiled/@vercel/sandbox/index.js";

import type { VercelCredentialBrokering } from "#execution/sandbox/bindings/vercel-credentials.js";
import { resolveVercelCredentialPolicy } from "#execution/sandbox/bindings/vercel-credentials.js";
import {
  clearVercelEgressDemandMarkers,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";
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
  initialCredentials: ReadonlyMap<
    string,
    import("#runtime/connections/types.js").TokenResult
  > = new Map(),
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  let credentials = new Map(initialCredentials);
  const onRequestRuleIds =
    brokering === undefined
      ? []
      : [...brokering.rules.values()]
          .filter((rule) => rule.credentialResolution === "on-request")
          .map((rule) => rule.id);
  const demandHandler =
    brokering === undefined
      ? undefined
      : {
          hasDemand: async (): Promise<boolean> =>
            (await readVercelEgressDemandedRuleIds(sandbox, onRequestRuleIds)).length > 0,
          resolveDemand: async (): Promise<void> => {
            const demanded = await readVercelEgressDemandedRuleIds(sandbox, onRequestRuleIds);
            const unresolved = demanded.filter((ruleId) => !credentials.has(ruleId));
            if (unresolved.length === 0) {
              await clearVercelEgressDemandMarkers(sandbox, demanded);
              return;
            }
            let resolved;
            try {
              resolved = await resolveVercelCredentialPolicy(
                brokering,
                sessionKey,
                unresolved,
                sandbox.name,
              );
            } catch (error) {
              await sandbox.update({
                networkPolicy: brokering.buildPolicy(credentials, sandbox.name),
              });
              await clearVercelEgressDemandMarkers(sandbox, unresolved);
              throw error;
            }
            credentials = new Map([...credentials, ...resolved.credentials]);
            await sandbox.update({
              networkPolicy: brokering.buildPolicy(credentials, sandbox.name),
            });
            await clearVercelEgressDemandMarkers(sandbox, unresolved);
            if (resolved.unresolvedRuleIds.length > 0) {
              throw new Error(
                `Sandbox credentials remained unavailable for on-request rules: ${resolved.unresolvedRuleIds.join(
                  ", ",
                )}.`,
              );
            }
          },
        };
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey, demandHandler),
      createVercelNetworkPolicySetter(sandbox, brokering !== undefined),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        if (brokering !== undefined && options.networkPolicy !== undefined) {
          throw new Error(
            "vercel(): `onSession` cannot replace `networkPolicy` when managed `auth` rules exist.",
          );
        }
        await sandbox.update(options);
      }
      if (brokeredPolicy !== undefined) {
        await sandbox.update({ networkPolicy: brokeredPolicy });
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey, demandHandler),
        createVercelNetworkPolicySetter(sandbox, brokering !== undefined),
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
        await sandbox.update({ networkPolicy: brokering.clearedPolicy });
      }
    },
  };
}

export function createVercelInternalSandboxSession(
  sandbox: SdkSandbox,
  id: string,
  demandHandler?: VercelDemandHandler,
): InternalSandboxSession {
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const startCommand = async () =>
        await sandbox.runCommand({
          args: ["-lc", options.command],
          cmd: "bash",
          cwd: options.workingDirectory ?? WORKSPACE_ROOT,
          detached: true,
          env: options.env,
          signal: options.abortSignal,
        });
      const command = await startCommand();
      return demandHandler === undefined
        ? adaptVercelCommandToSandboxProcess(command)
        : adaptDemandAwareVercelProcess(command, startCommand, demandHandler);
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
  managed = false,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    if (managed) {
      throw new Error(
        "vercel(): `setNetworkPolicy` is unavailable when managed `auth` rules exist.",
      );
    }
    await sandbox.update({ networkPolicy: policy });
  };
}

const MAX_ON_REQUEST_REPLAYS = 3;
const DEMAND_POLL_INTERVAL_MS = 50;
const ATTEMPT_LOG_TAIL_BYTES = 64 * 1024;
const ATTEMPT_LOG_TAIL_DELAY_MS = 100;

function adaptDemandAwareVercelProcess(
  initialCommand: SdkSandboxCommand,
  startCommand: () => Promise<SdkSandboxCommand>,
  demandHandler: VercelDemandHandler,
): SandboxProcess {
  const encoder = new TextEncoder();
  let activeCommand = initialCommand;
  let killed = false;
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => (stdoutController = controller),
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => (stderrController = controller),
  });

  const execute = async (): Promise<{ readonly exitCode: number }> => {
    let replayCount = 0;
    let activeLogs: ReplayAwareCommandLogs | undefined;
    try {
      while (true) {
        const command = activeCommand;
        const attemptLogs = new ReplayAwareCommandLogs(stdoutController, stderrController);
        activeLogs = attemptLogs;
        const logs = collectCommandLogs(command, encoder, attemptLogs);
        const finished = command.wait();
        let result: Awaited<typeof finished> | undefined;
        let replayRequired = false;
        while (result === undefined) {
          const outcome = await Promise.race([
            finished.then((value) => ({ kind: "finished" as const, value })),
            delay(DEMAND_POLL_INTERVAL_MS).then(() => ({ kind: "poll" as const })),
          ]);
          if (outcome.kind === "finished") {
            attemptLogs.hold();
            result = outcome.value;
            break;
          }
          if (await demandHandler.hasDemand()) {
            attemptLogs.discard();
            await command.kill().catch(() => {});
            await finished.catch(() => undefined);
            await logs;
            await demandHandler.resolveDemand();
            replayRequired = true;
            break;
          }
        }
        await logs;
        const demandedAfterExit = await demandHandler.hasDemand();
        if (demandedAfterExit) {
          attemptLogs.discard();
          await demandHandler.resolveDemand();
          replayRequired = true;
        }
        if (!replayRequired && result !== undefined) {
          attemptLogs.flush();
          return { exitCode: result.exitCode };
        }
        activeLogs = undefined;
        if (killed) return { exitCode: result?.exitCode ?? 137 };
        replayCount += 1;
        if (replayCount > MAX_ON_REQUEST_REPLAYS) {
          throw new Error(
            `Sandbox command exceeded ${MAX_ON_REQUEST_REPLAYS} on-request authorization replays.`,
          );
        }
        activeCommand = await startCommand();
      }
    } finally {
      activeLogs?.discard();
      stdoutController.close();
      stderrController.close();
    }
  };
  let execution: Promise<{ readonly exitCode: number }> | undefined;

  return {
    stdout,
    stderr,
    async wait() {
      execution ??= execute();
      return await execution;
    },
    async kill() {
      killed = true;
      await activeCommand.kill();
      if (execution === undefined) {
        stdoutController.close();
        stderrController.close();
      }
    },
  };
}

interface VercelDemandHandler {
  readonly hasDemand: () => Promise<boolean>;
  readonly resolveDemand: () => Promise<void>;
}

async function collectCommandLogs(
  command: SdkSandboxCommand,
  encoder: TextEncoder,
  output: ReplayAwareCommandLogs,
): Promise<void> {
  for await (const message of command.logs()) {
    output.push(encoder.encode(message.data), message.stream);
  }
}

class ReplayAwareCommandLogs {
  readonly #stderr: ReadableStreamDefaultController<Uint8Array>;
  readonly #stdout: ReadableStreamDefaultController<Uint8Array>;
  #bytes = 0;
  #discarded = false;
  #held = false;
  #messages: Array<{ readonly data: Uint8Array; readonly stream: "stdout" | "stderr" }> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    stdout: ReadableStreamDefaultController<Uint8Array>,
    stderr: ReadableStreamDefaultController<Uint8Array>,
  ) {
    this.#stdout = stdout;
    this.#stderr = stderr;
  }

  push(data: Uint8Array, stream: "stdout" | "stderr"): void {
    if (this.#discarded) return;
    this.#messages.push({ data, stream });
    this.#bytes += data.byteLength;
    this.#flushOverflow();
    if (!this.#held && this.#timer === undefined) {
      this.#timer = setTimeout(() => this.flush(), ATTEMPT_LOG_TAIL_DELAY_MS);
    }
  }

  hold(): void {
    this.#held = true;
    this.#clearTimer();
  }

  discard(): void {
    this.#discarded = true;
    this.#clearTimer();
    this.#messages = [];
    this.#bytes = 0;
  }

  flush(): void {
    if (this.#discarded) return;
    this.#clearTimer();
    const messages = this.#messages;
    this.#messages = [];
    this.#bytes = 0;
    for (const message of messages) {
      this.#emit(message);
    }
  }

  #flushOverflow(): void {
    while (this.#bytes > ATTEMPT_LOG_TAIL_BYTES) {
      const message = this.#messages[0];
      if (message === undefined) return;
      const overflow = this.#bytes - ATTEMPT_LOG_TAIL_BYTES;
      if (message.data.byteLength <= overflow) {
        this.#messages.shift();
        this.#bytes -= message.data.byteLength;
        this.#emit(message);
        continue;
      }
      this.#emit({ ...message, data: message.data.subarray(0, overflow) });
      this.#messages[0] = { ...message, data: message.data.subarray(overflow) };
      this.#bytes -= overflow;
    }
  }

  #emit(message: { readonly data: Uint8Array; readonly stream: "stdout" | "stderr" }): void {
    (message.stream === "stdout" ? this.#stdout : this.#stderr).enqueue(message.data);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
