import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import type {
  ComputerAction,
  ComputerActionResult,
  ComputerPoint,
  ComputerScreenshot,
} from "#computer/action.js";
import type { ComputerBackend, ComputerExecuteContext } from "#computer/backend.js";
import { ComputerError, defineComputerBackend } from "#computer/backend.js";

export interface SystemComputerOptions {
  /**
   * X11 display to drive on Linux. Defaults to `DISPLAY`, then `:0`, so a
   * headless service can target a virtual framebuffer.
   */
  readonly display?: string;
  /** Per-command timeout. Defaults to 20 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Controls the display of the machine eve is running on.
 *
 * Screen capture and input injection are operating-system services, not
 * library calls, so each platform delegates to the tools that ship with (or
 * are conventionally installed on) it. A missing tool produces a
 * {@link ComputerError} naming the tool and the install command rather than
 * a spawn failure.
 */
export function systemComputer(options: SystemComputerOptions = {}): ComputerBackend {
  const adapter = selectAdapter(options);

  return defineComputerBackend({
    id: `system:${platform}`,
    async execute(action, context): Promise<ComputerActionResult> {
      return adapter.execute(action, context);
    },
  });
}

interface SystemAdapter {
  execute(action: ComputerAction, context: ComputerExecuteContext): Promise<ComputerActionResult>;
}

function selectAdapter(options: SystemComputerOptions): SystemAdapter {
  const timeoutMs = options.timeoutMs ?? 20_000;
  switch (platform) {
    case "linux":
      return linuxAdapter(options.display ?? process.env.DISPLAY ?? ":0", timeoutMs);
    case "darwin":
      return macosAdapter(timeoutMs);
    case "win32":
      return windowsAdapter(timeoutMs);
    default:
      throw new ComputerError(
        "unsupported",
        `systemComputer() has no adapter for platform "${platform}". Use remoteComputer() to drive a supported machine, or virtualComputer() for tests.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Linux (X11)
// ---------------------------------------------------------------------------

function linuxAdapter(display: string, timeoutMs: number): SystemAdapter {
  const env = { ...process.env, DISPLAY: display };
  const xdotool = (args: readonly string[], context: ComputerExecuteContext) =>
    run("xdotool", args, {
      context,
      env,
      hint: "Install it with `apt-get install -y xdotool` (Debian/Ubuntu) or your distribution's package manager.",
      timeoutMs,
    });

  return {
    async execute(action, context) {
      switch (action.action) {
        case "screenshot":
          return { screenshot: await linuxScreenshot(env, context, timeoutMs) };
        case "screen_size": {
          const output = await xdotool(["getdisplaygeometry"], context);
          const [width, height] = output.stdout.toString("utf8").trim().split(/\s+/).map(Number);
          if (!Number.isInteger(width) || !Number.isInteger(height)) {
            throw new ComputerError("unavailable", `No usable X display at DISPLAY=${display}.`);
          }
          return { screen: { height: height!, width: width! } };
        }
        case "cursor_position": {
          const output = await xdotool(["getmouselocation", "--shell"], context);
          return { cursor: parseShellPoint(output.stdout.toString("utf8")) };
        }
        case "wait":
          await sleep(action.durationMs, context);
          return { text: `Waited ${action.durationMs}ms.` };
        case "hold_key":
          await xdotool(["keydown", ...action.keys.split("+")], context);
          await sleep(action.durationMs, context);
          await xdotool(["keyup", ...action.keys.split("+").toReversed()], context);
          return { text: `Held ${action.keys} for ${action.durationMs}ms.` };
        case "mouse_move":
          await xdotool(["mousemove", ...action.coordinate.map(String)], context);
          return { text: `Moved to (${action.coordinate.join(", ")}).` };
        case "left_mouse_down":
          await xdotool([...moveArgs(action.coordinate), "mousedown", "1"], context);
          return { text: "Left button down." };
        case "left_mouse_up":
          await xdotool([...moveArgs(action.coordinate), "mouseup", "1"], context);
          return { text: "Left button up." };
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click": {
          const repeat = clickRepeat(action.action);
          const button = clickButton(action.action);
          const held = action.modifiers ?? [];
          for (const modifier of held) await xdotool(["keydown", modifier], context);
          try {
            await xdotool(
              [...moveArgs(action.coordinate), "click", "--repeat", String(repeat), button],
              context,
            );
          } finally {
            for (const modifier of held.toReversed()) await xdotool(["keyup", modifier], context);
          }
          return { text: `${action.action} at ${describePoint(action.coordinate)}.` };
        }
        case "left_click_drag":
          await xdotool(
            [
              ...moveArgs(action.from),
              "mousedown",
              "1",
              "mousemove",
              ...action.to.map(String),
              "mouseup",
              "1",
            ],
            context,
          );
          return { text: `Dragged to (${action.to.join(", ")}).` };
        case "scroll": {
          const button = { up: "4", down: "5", left: "6", right: "7" }[action.direction];
          await xdotool(
            [...moveArgs(action.coordinate), "click", "--repeat", String(action.amount), button],
            context,
          );
          return { text: `Scrolled ${action.direction} by ${action.amount}.` };
        }
        case "type":
          await xdotool(["type", "--delay", "12", "--", action.text], context);
          return { text: `Typed ${action.text.length} characters.` };
        case "key":
          await xdotool(["key", "--", action.keys], context);
          return { text: `Pressed ${action.keys}.` };
      }
    },
  };
}

async function linuxScreenshot(
  env: NodeJS.ProcessEnv,
  context: ComputerExecuteContext,
  timeoutMs: number,
): Promise<ComputerScreenshot> {
  const attempts: readonly (readonly [string, readonly string[]])[] = [
    ["import", ["-silent", "-window", "root", "png:-"]],
    ["scrot", ["--overwrite", "-"]],
    ["gnome-screenshot", ["-f", "/dev/stdout"]],
  ];
  const missing: string[] = [];
  for (const [command, args] of attempts) {
    try {
      const output = await run(command, args, { context, env, timeoutMs });
      return toScreenshot(output.stdout);
    } catch (error) {
      if (ComputerError.is(error) && error.reason === "unsupported") {
        missing.push(command);
        continue;
      }
      throw error;
    }
  }
  throw new ComputerError(
    "unsupported",
    `No screen-capture tool found (tried ${missing.join(", ")}). Install one with \`apt-get install -y imagemagick\` or \`apt-get install -y scrot\`.`,
  );
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

function macosAdapter(timeoutMs: number): SystemAdapter {
  const cliclick = (args: readonly string[], context: ComputerExecuteContext) =>
    run("cliclick", args, {
      context,
      hint: "Install it with `brew install cliclick`, and grant your terminal Accessibility permission in System Settings > Privacy & Security.",
      timeoutMs,
    });

  return {
    async execute(action, context) {
      switch (action.action) {
        case "screenshot":
          return { screenshot: await macosScreenshot(context, timeoutMs) };
        case "screen_size": {
          const screenshot = await macosScreenshot(context, timeoutMs);
          return { screen: { height: screenshot.height, width: screenshot.width } };
        }
        case "cursor_position": {
          const output = await cliclick(["p:"], context);
          const [x, y] = output.stdout.toString("utf8").trim().split(",").map(Number);
          return { cursor: { x: x ?? 0, y: y ?? 0 } };
        }
        case "wait":
          await sleep(action.durationMs, context);
          return { text: `Waited ${action.durationMs}ms.` };
        case "hold_key":
          await cliclick([`kd:${action.keys.split("+").join(",")}`], context);
          await sleep(action.durationMs, context);
          await cliclick([`ku:${action.keys.split("+").join(",")}`], context);
          return { text: `Held ${action.keys} for ${action.durationMs}ms.` };
        case "mouse_move":
          await cliclick([`m:${action.coordinate.join(",")}`], context);
          return { text: `Moved to (${action.coordinate.join(", ")}).` };
        case "left_mouse_down":
          await cliclick([...macosMove(action.coordinate), "dd:."], context);
          return { text: "Left button down." };
        case "left_mouse_up":
          await cliclick([...macosMove(action.coordinate), "du:."], context);
          return { text: "Left button up." };
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click": {
          const verb = {
            left_click: "c",
            right_click: "rc",
            middle_click: "c",
            double_click: "dc",
            triple_click: "tc",
          }[action.action];
          const held = action.modifiers ?? [];
          if (held.length > 0) await cliclick([`kd:${held.join(",")}`], context);
          try {
            await cliclick([...macosMove(action.coordinate), `${verb}:.`], context);
          } finally {
            if (held.length > 0) await cliclick([`ku:${held.join(",")}`], context);
          }
          return { text: `${action.action} at ${describePoint(action.coordinate)}.` };
        }
        case "left_click_drag":
          await cliclick(
            [...macosMove(action.from), "dd:.", `m:${action.to.join(",")}`, "du:."],
            context,
          );
          return { text: `Dragged to (${action.to.join(", ")}).` };
        case "scroll": {
          const signed =
            action.direction === "up" || action.direction === "left"
              ? action.amount
              : -action.amount;
          const axis = action.direction === "left" || action.direction === "right" ? "sh" : "s";
          await cliclick([...macosMove(action.coordinate), `${axis}:${signed}`], context);
          return { text: `Scrolled ${action.direction} by ${action.amount}.` };
        }
        case "type":
          await cliclick(["-w", "12", `t:${action.text}`], context);
          return { text: `Typed ${action.text.length} characters.` };
        case "key":
          await cliclick([`kp:${action.keys.split("+").join(",")}`], context);
          return { text: `Pressed ${action.keys}.` };
      }
    },
  };
}

function macosMove(coordinate: readonly [number, number] | undefined): readonly string[] {
  return coordinate === undefined ? [] : [`m:${coordinate.join(",")}`];
}

async function macosScreenshot(
  context: ComputerExecuteContext,
  timeoutMs: number,
): Promise<ComputerScreenshot> {
  const directory = await mkdtemp(join(tmpdir(), "eve-computer-"));
  const file = join(directory, "screen.png");
  try {
    await run("screencapture", ["-x", "-t", "png", file], {
      context,
      hint: "`screencapture` ships with macOS; grant Screen Recording permission in System Settings > Privacy & Security.",
      timeoutMs,
    });
    return toScreenshot(await readFile(file));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WINDOWS_PRELUDE = `
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class EveInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p);
}
'@
`;

function windowsAdapter(timeoutMs: number): SystemAdapter {
  const powershell = (script: string, context: ComputerExecuteContext) =>
    run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `${WINDOWS_PRELUDE}\n${script}`],
      {
        context,
        hint: "Windows control requires Windows PowerShell 5.1 or later on PATH.",
        timeoutMs,
      },
    );

  const click = async (
    action: ComputerAction & { action: string },
    context: ComputerExecuteContext,
    coordinate: readonly [number, number] | undefined,
    down: number,
    up: number,
    repeat: number,
  ) => {
    const move =
      coordinate === undefined
        ? ""
        : `[EveInput]::SetCursorPos(${coordinate[0]}, ${coordinate[1]});`;
    await powershell(
      `${move} 1..${repeat} | ForEach-Object { [EveInput]::mouse_event(${down},0,0,0,0); [EveInput]::mouse_event(${up},0,0,0,0); Start-Sleep -Milliseconds 40 }`,
      context,
    );
    return { text: `${action.action} at ${describePoint(coordinate)}.` };
  };

  return {
    async execute(action, context) {
      switch (action.action) {
        case "screenshot":
        case "screen_size": {
          const output = await powershell(
            `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))`,
            context,
          );
          const screenshot = toScreenshot(
            Buffer.from(output.stdout.toString("utf8").trim(), "base64"),
          );
          return action.action === "screenshot"
            ? { screenshot }
            : { screen: { height: screenshot.height, width: screenshot.width } };
        }
        case "cursor_position": {
          const output = await powershell(
            `$p = New-Object System.Drawing.Point; [void][EveInput]::GetCursorPos([ref]$p); "$($p.X),$($p.Y)"`,
            context,
          );
          const [x, y] = output.stdout.toString("utf8").trim().split(",").map(Number);
          return { cursor: { x: x ?? 0, y: y ?? 0 } };
        }
        case "wait":
          await sleep(action.durationMs, context);
          return { text: `Waited ${action.durationMs}ms.` };
        case "hold_key":
          await powershell(
            `[System.Windows.Forms.SendKeys]::SendWait('${sendKeys(action.keys)}')`,
            context,
          );
          await sleep(action.durationMs, context);
          return { text: `Held ${action.keys} for ${action.durationMs}ms.` };
        case "mouse_move":
          await powershell(
            `[void][EveInput]::SetCursorPos(${action.coordinate[0]}, ${action.coordinate[1]})`,
            context,
          );
          return { text: `Moved to (${action.coordinate.join(", ")}).` };
        case "left_mouse_down":
          return click(action, context, action.coordinate, 0x0002, 0x0002, 0).then(() => ({
            text: "Left button down.",
          }));
        case "left_mouse_up":
          await powershell(`[EveInput]::mouse_event(0x0004,0,0,0,0)`, context);
          return { text: "Left button up." };
        case "left_click":
          return click(action, context, action.coordinate, 0x0002, 0x0004, 1);
        case "double_click":
          return click(action, context, action.coordinate, 0x0002, 0x0004, 2);
        case "triple_click":
          return click(action, context, action.coordinate, 0x0002, 0x0004, 3);
        case "right_click":
          return click(action, context, action.coordinate, 0x0008, 0x0010, 1);
        case "middle_click":
          return click(action, context, action.coordinate, 0x0020, 0x0040, 1);
        case "left_click_drag":
          await powershell(
            `${action.from === undefined ? "" : `[void][EveInput]::SetCursorPos(${action.from[0]}, ${action.from[1]});`} [EveInput]::mouse_event(0x0002,0,0,0,0); [void][EveInput]::SetCursorPos(${action.to[0]}, ${action.to[1]}); [EveInput]::mouse_event(0x0004,0,0,0,0)`,
            context,
          );
          return { text: `Dragged to (${action.to.join(", ")}).` };
        case "scroll": {
          const delta = (action.direction === "down" ? -120 : 120) * action.amount;
          const move =
            action.coordinate === undefined
              ? ""
              : `[void][EveInput]::SetCursorPos(${action.coordinate[0]}, ${action.coordinate[1]});`;
          await powershell(`${move} [EveInput]::mouse_event(0x0800,0,0,${delta},0)`, context);
          return { text: `Scrolled ${action.direction} by ${action.amount}.` };
        }
        case "type":
          await powershell(
            `[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShell(action.text)}')`,
            context,
          );
          return { text: `Typed ${action.text.length} characters.` };
        case "key":
          await powershell(
            `[System.Windows.Forms.SendKeys]::SendWait('${sendKeys(action.keys)}')`,
            context,
          );
          return { text: `Pressed ${action.keys}.` };
      }
    },
  };
}

const SEND_KEYS_NAMES: Readonly<Record<string, string>> = {
  alt: "%",
  ctrl: "^",
  control: "^",
  shift: "+",
  return: "{ENTER}",
  enter: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  space: " ",
};

function sendKeys(chord: string): string {
  return chord
    .split("+")
    .map((part) => SEND_KEYS_NAMES[part.toLowerCase()] ?? escapePowerShell(part))
    .join("");
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function moveArgs(coordinate: readonly [number, number] | undefined): readonly string[] {
  return coordinate === undefined ? [] : ["mousemove", ...coordinate.map(String)];
}

function clickRepeat(action: string): number {
  if (action === "double_click") return 2;
  if (action === "triple_click") return 3;
  return 1;
}

function clickButton(action: string): string {
  if (action === "right_click") return "3";
  if (action === "middle_click") return "2";
  return "1";
}

function describePoint(coordinate: readonly [number, number] | undefined): string {
  return coordinate === undefined ? "the current cursor position" : `(${coordinate.join(", ")})`;
}

function parseShellPoint(output: string): ComputerPoint {
  const x = /^X=(\d+)$/m.exec(output)?.[1];
  const y = /^Y=(\d+)$/m.exec(output)?.[1];
  if (x === undefined || y === undefined) {
    throw new ComputerError("failed", "Could not read the cursor position from xdotool.");
  }
  return { x: Number(x), y: Number(y) };
}

/** Reads width and height from a PNG IHDR chunk. */
export function toScreenshot(bytes: Buffer): ComputerScreenshot {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new ComputerError(
      "failed",
      "Screen capture did not return a PNG. Check that the capture tool has permission to read the display.",
    );
  }
  return {
    base64: bytes.toString("base64"),
    height: bytes.readUInt32BE(20),
    mediaType: "image/png",
    width: bytes.readUInt32BE(16),
  };
}

interface RunResult {
  readonly stderr: string;
  readonly stdout: Buffer;
}

async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly context: ComputerExecuteContext;
    readonly env?: NodeJS.ProcessEnv;
    readonly hint?: string;
    readonly timeoutMs: number;
  },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      signal: AbortSignal.any([
        options.context.abortSignal,
        AbortSignal.timeout(options.timeoutMs),
      ]),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new ComputerError(
            "unsupported",
            `\`${command}\` is not installed on this machine. ${options.hint ?? ""}`.trim(),
            { cause: error },
          ),
        );
        return;
      }
      reject(
        new ComputerError("failed", `\`${command}\` failed: ${error.message}`, { cause: error }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout: Buffer.concat(stdout) });
        return;
      }
      reject(
        new ComputerError(
          "failed",
          `\`${command} ${args.join(" ")}\` exited with code ${code}. ${stderr.trim()}`.trim(),
        ),
      );
    });
  });
}

function sleep(durationMs: number, context: ComputerExecuteContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      context.abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(context.abortSignal.reason);
    };
    context.abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
