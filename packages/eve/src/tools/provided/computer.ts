import {
  COMPUTER_ACTION_SCHEMA,
  isReadOnlyComputerAction,
  type ComputerAction,
  type ComputerActionResult,
} from "#computer/action.js";
import type { ComputerBackend } from "#computer/backend.js";
import { defaultComputerBackend } from "#computer/backends/default.js";
import type { Approval } from "#public/definitions/approval.js";
import { once } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { toolOutput, toolOutputPart } from "#tools/model-output.js";

export const COMPUTER_INPUT_SCHEMA = COMPUTER_ACTION_SCHEMA;

export interface ComputerToolOutput extends ComputerActionResult {
  readonly action: ComputerAction["action"];
}

export interface ComputerToolOptions {
  /**
   * Approval policy for the tool. Defaults to `once()`: driving a real
   * machine is consequential, so the first action asks and the rest of the
   * session proceeds.
   */
  readonly approval?: Approval<ComputerAction>;
  /** Machine to drive. Defaults to the environment-resolved backend. */
  readonly backend?: ComputerBackend;
}

const DESCRIPTION = [
  "Control a computer: look at its screen and drive its mouse and keyboard.",
  "",
  "Start with `screenshot` to see the screen, and use the pixel coordinates in that image.",
  "Coordinates are measured from the top-left corner. Take a fresh screenshot after any action",
  "that changes the screen, and after `wait` when an application is still loading.",
  "",
  "`key` and `hold_key` take xdotool chords, e.g. `Return`, `ctrl+s`, `alt+Tab`.",
  "`type` enters literal text and does not press Enter.",
].join("\n");

/**
 * Builds the `computer` tool bound to a specific machine. Use it from
 * `agent/tools/computer.ts` when the agent should drive a backend other
 * than the environment default.
 */
export function computer(options: ComputerToolOptions = {}) {
  const backend = options.backend ?? defaultComputerBackend();

  return defineTool({
    approval: options.approval ?? once<ComputerAction>(),
    description: DESCRIPTION,
    async execute(input, context): Promise<ComputerToolOutput> {
      const result = await backend.execute(input, { abortSignal: context.abortSignal });
      return { ...result, action: input.action };
    },
    inputSchema: COMPUTER_INPUT_SCHEMA,
    toModelOutput(output) {
      const parts = [toolOutputPart.text(describe(output))];
      if (output.screenshot !== undefined) {
        parts.push(
          toolOutputPart.file(output.screenshot.base64, {
            filename: "screen.png",
            mediaType: output.screenshot.mediaType,
          }),
        );
      }
      return toolOutput.content(parts);
    },
  });
}

function describe(output: ComputerToolOutput): string {
  const lines: string[] = [];
  if (output.text !== undefined) lines.push(output.text);
  if (output.screen !== undefined) {
    lines.push(`Screen is ${output.screen.width}x${output.screen.height} pixels.`);
  }
  if (output.cursor !== undefined) {
    lines.push(`Cursor is at (${output.cursor.x}, ${output.cursor.y}).`);
  }
  if (output.screenshot !== undefined) {
    lines.push(`Screenshot of the ${output.screenshot.width}x${output.screenshot.height} screen:`);
  }
  if (lines.length === 0) lines.push(`${output.action} completed.`);
  return lines.join("\n");
}

export { isReadOnlyComputerAction };

export default computer();
