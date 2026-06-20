import { Client } from "#client/index.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import type { LocalDevelopmentUserCredential } from "#services/dev-client/local-user-credential.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import type { TuiDisplayOptions } from "./types.js";

/**
 * Options for running the `eve dev` terminal UI against a server URL.
 */
export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /**
   * The eve server URL the TUI connects to — either the in-process dev
   * server started by `eve dev`, or a remote `--url` target.
   */
  readonly serverUrl: string;
  /**
   * Absolute application root. Present when the TUI starts or attaches to this
   * project's local server, enabling setup commands to edit local agent source.
   */
  readonly appRoot?: string;
  /**
   * Temporary credential registered with the matching local dev server. It lets
   * `localDev()` address a stable user-scoped Connect grant without trusting a
   * caller-provided user id.
   */
  readonly localUserCredential?: Pick<LocalDevelopmentUserCredential, "refresh" | "token">;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted — the user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
}

/**
 * Runs the `eve dev` terminal UI against the given server URL until the
 * user exits.
 *
 * The configured client is handed to the runner so its subagent
 * child-session streams inherit the same auth. Turn-dispatch failures —
 * including the Vercel Deployment Protection challenge — are formatted into
 * the inline error region rather than crashing the command.
 */
export async function runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void> {
  const { serverUrl, appRoot, initialInput, localUserCredential, ...display } = input;

  const client = new Client(
    resolveDevelopmentClientOptions(serverUrl, {
      resolveLocalUserCredential: () => localUserCredential?.token,
    }),
  );

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler({
      appRoot,
      afterSetupCommand: async () => {
        await localUserCredential?.refresh();
      },
    }),
    prepareTurn: async () => {
      await localUserCredential?.refresh();
    },
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatVercelAuthChallengeMessage({ serverUrl })
        : toErrorMessage(error),
  };
  if (appRoot !== undefined) options.appRoot = appRoot;
  if (initialInput !== undefined) options.initialInput = initialInput;

  await new EveTUIRunner(options).run();
}
