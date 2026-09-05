import { platform } from "node:process";

import type { ComputerBackend } from "#computer/backend.js";
import { ComputerError, defineComputerBackend } from "#computer/backend.js";
import { remoteComputer } from "#computer/backends/remote.js";
import { systemComputer } from "#computer/backends/system.js";

/**
 * Selects a backend from the environment, lazily, so importing the computer
 * tool never probes the machine and a misconfigured deployment fails at the
 * first action with an actionable message instead of at import time.
 *
 * | Environment                                | Backend           |
 * | ------------------------------------------ | ----------------- |
 * | `EVE_COMPUTER_URL` and `EVE_COMPUTER_TOKEN`| {@link remoteComputer} |
 * | A local display (`DISPLAY`, macOS, Windows)| {@link systemComputer} |
 * | Anything else                              | An error asking for an explicit backend |
 */
export function defaultComputerBackend(): ComputerBackend {
  let resolved: ComputerBackend | undefined;

  return defineComputerBackend({
    id: "default",
    async execute(action, context) {
      resolved ??= resolveComputerBackend();
      return resolved.execute(action, context);
    },
  });
}

function resolveComputerBackend(): ComputerBackend {
  const url = process.env.EVE_COMPUTER_URL?.trim();
  const token = process.env.EVE_COMPUTER_TOKEN?.trim();
  if (url !== undefined && url.length > 0) {
    if (token === undefined || token.length === 0) {
      throw new ComputerError(
        "unavailable",
        "EVE_COMPUTER_URL is set but EVE_COMPUTER_TOKEN is not. Set both to the values the eve desktop app shows under Computer > Remote control.",
      );
    }
    return remoteComputer({ token, url });
  }

  if (platform === "darwin" || platform === "win32" || process.env.DISPLAY !== undefined) {
    return systemComputer();
  }

  throw new ComputerError(
    "unavailable",
    "No computer is configured. Set EVE_COMPUTER_URL and EVE_COMPUTER_TOKEN to drive the machine running the eve desktop app, or pass an explicit backend to `computer()` from `eve/computer`.",
  );
}
