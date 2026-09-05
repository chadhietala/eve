import type { ComputerAction, ComputerPoint } from "#computer/action.js";
import type { ComputerBackend, ComputerExecuteContext } from "#computer/backend.js";
import { ComputerError } from "#computer/backend.js";
import { drawText, GLYPH_HEIGHT, measureText } from "#computer/font.js";
import { encodePng } from "#computer/png.js";

const DEFAULT_WIDTH = 1_024;
const DEFAULT_HEIGHT = 640;
const DEFAULT_BACKGROUND = "#0a0a0a";
const DEFAULT_ELEMENT_FILL = "#171717";
const DEFAULT_ELEMENT_TEXT = "#ededed";
const CURSOR_COLOR = "#ffffff";

/** A rectangle the virtual screen draws and that a click can activate. */
export interface VirtualComputerElement {
  /** `[x, y, width, height]` in screen pixels. */
  readonly bounds: readonly [number, number, number, number];
  readonly fill?: string;
  readonly id: string;
  readonly label: string;
  /** Runs when a click lands inside {@link bounds}. */
  readonly onActivate?: (context: VirtualComputerActivateContext) => void;
  readonly textColor?: string;
}

export interface VirtualComputerActivateContext {
  readonly action: ComputerAction;
  readonly computer: VirtualComputer;
  readonly point: ComputerPoint;
}

export interface VirtualComputerOptions {
  readonly background?: string;
  readonly elements?: readonly VirtualComputerElement[];
  readonly height?: number;
  /** Text drawn at the top of the screen. Useful as a title bar in evals. */
  readonly title?: string;
  readonly width?: number;
}

/**
 * A deterministic, fully in-process computer. It draws a real PNG, tracks a
 * cursor, and routes clicks to elements, so computer-use behavior can be
 * asserted in unit tests and evals without a display server.
 */
export interface VirtualComputer extends ComputerBackend {
  /** Every action the backend has executed, oldest first. */
  readonly actions: readonly ComputerAction[];
  readonly cursor: ComputerPoint;
  readonly elements: readonly VirtualComputerElement[];
  /** Every key chord sent with the `key` action, oldest first. */
  readonly keys: readonly string[];
  /** Concatenation of every `type` action. */
  readonly typed: string;
  setElements(elements: readonly VirtualComputerElement[]): void;
  setTitle(title: string): void;
}

export function virtualComputer(options: VirtualComputerOptions = {}): VirtualComputer {
  const width = normalizeDimension(options.width ?? DEFAULT_WIDTH, "width");
  const height = normalizeDimension(options.height ?? DEFAULT_HEIGHT, "height");
  const background = parseColor(options.background ?? DEFAULT_BACKGROUND);

  const actions: ComputerAction[] = [];
  const keys: string[] = [];
  let elements = [...(options.elements ?? [])];
  let title = options.title ?? "";
  let cursor: ComputerPoint = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  let typed = "";
  let pressed = false;

  const computer: VirtualComputer = {
    id: "virtual",
    get actions() {
      return actions;
    },
    get cursor() {
      return cursor;
    },
    get elements() {
      return elements;
    },
    get keys() {
      return keys;
    },
    get typed() {
      return typed;
    },
    setElements(next) {
      elements = [...next];
    },
    setTitle(next) {
      title = next;
    },
    async execute(action, context) {
      context.abortSignal.throwIfAborted();
      actions.push(action);

      switch (action.action) {
        case "screenshot":
          return { screenshot: render() };
        case "screen_size":
          return { screen: { height, width } };
        case "cursor_position":
          return { cursor };
        case "wait":
        case "hold_key":
          if (action.action === "hold_key") keys.push(action.keys);
          await delay(action.durationMs, context);
          return { text: `Waited ${action.durationMs}ms.` };
        case "mouse_move":
          cursor = point(action.coordinate);
          return { cursor };
        case "left_mouse_down":
          moveIfGiven(action.coordinate);
          pressed = true;
          return { cursor, text: "Left button down." };
        case "left_mouse_up":
          moveIfGiven(action.coordinate);
          pressed = false;
          return { cursor, text: "Left button up." };
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click":
          moveIfGiven(action.coordinate);
          activate(action);
          return { cursor, screenshot: render() };
        case "left_click_drag":
          moveIfGiven(action.from);
          pressed = true;
          cursor = point(action.to);
          pressed = false;
          activate(action);
          return { cursor, screenshot: render() };
        case "scroll":
          moveIfGiven(action.coordinate);
          return { cursor, text: `Scrolled ${action.direction} by ${action.amount}.` };
        case "type":
          typed += action.text;
          return { text: `Typed ${action.text.length} characters.` };
        case "key":
          keys.push(action.keys);
          return { text: `Pressed ${action.keys}.` };
      }
    },
  };

  return computer;

  function moveIfGiven(coordinate: readonly [number, number] | undefined): void {
    if (coordinate !== undefined) cursor = point(coordinate);
  }

  function point(coordinate: readonly [number, number]): ComputerPoint {
    const [x, y] = coordinate;
    if (x >= width || y >= height) {
      throw new ComputerError(
        "invalid",
        `Coordinate (${x}, ${y}) is outside the ${width}x${height} screen. Take a screenshot and pick a point inside it.`,
      );
    }
    return { x, y };
  }

  function activate(action: ComputerAction): void {
    const hit = elements.find((element) => contains(element, cursor));
    hit?.onActivate?.({ action, computer, point: cursor });
  }

  function render() {
    const pixels = new Uint8Array(width * height * 4);
    fill(pixels, width, { x: 0, y: 0, width, height }, background);

    if (title.length > 0) {
      const scale = 3;
      fill(pixels, width, { x: 0, y: 0, width, height: 12 * scale }, parseColor("#111111"));
      drawText(title, {
        plot: (x, y) => plot(pixels, width, height, x, y, parseColor(DEFAULT_ELEMENT_TEXT)),
        scale,
        x: 8,
        y: Math.floor((12 * scale - GLYPH_HEIGHT * scale) / 2),
      });
    }

    for (const element of elements) {
      const [x, y, elementWidth, elementHeight] = element.bounds;
      fill(
        pixels,
        width,
        { x, y, width: elementWidth, height: elementHeight },
        parseColor(element.fill ?? DEFAULT_ELEMENT_FILL),
      );
      const scale = Math.max(1, Math.min(4, Math.floor(elementHeight / (GLYPH_HEIGHT * 2))));
      const textWidth = measureText(element.label, scale);
      drawText(element.label, {
        plot: (px, py) =>
          plot(
            pixels,
            width,
            height,
            px,
            py,
            parseColor(element.textColor ?? DEFAULT_ELEMENT_TEXT),
          ),
        scale,
        x: x + Math.max(2, Math.floor((elementWidth - textWidth) / 2)),
        y: y + Math.max(2, Math.floor((elementHeight - GLYPH_HEIGHT * scale) / 2)),
      });
    }

    const cursorColor = parseColor(pressed ? "#0070f3" : CURSOR_COLOR);
    for (let offset = 0; offset < 10; offset += 1) {
      plot(pixels, width, height, cursor.x + offset, cursor.y, cursorColor);
      plot(pixels, width, height, cursor.x, cursor.y + offset, cursorColor);
      plot(pixels, width, height, cursor.x + offset, cursor.y + offset, cursorColor);
    }

    return {
      base64: encodePng({ height, pixels, width }).toString("base64"),
      height,
      mediaType: "image/png",
      width,
    };
  }
}

function contains(element: VirtualComputerElement, point: ComputerPoint): boolean {
  const [x, y, width, height] = element.bounds;
  return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
}

function fill(
  pixels: Uint8Array,
  stride: number,
  rectangle: { height: number; width: number; x: number; y: number },
  color: readonly [number, number, number],
): void {
  const height = pixels.length / 4 / stride;
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
      plot(pixels, stride, height, x, y, color);
    }
  }
}

function plot(
  pixels: Uint8Array,
  stride: number,
  height: number,
  x: number,
  y: number,
  color: readonly [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= stride || y >= height) return;
  const offset = (y * stride + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = 255;
}

function parseColor(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) {
    throw new TypeError(
      `Color must be a six-digit hex string like "#0a0a0a", received "${value}".`,
    );
  }
  const hex = Number.parseInt(match[1]!, 16);
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function normalizeDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 16 || value > 8_192) {
    throw new TypeError(`virtualComputer() ${label} must be an integer between 16 and 8192.`);
  }
  return value;
}

function delay(durationMs: number, context: ComputerExecuteContext): Promise<void> {
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
