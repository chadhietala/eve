import { z } from "#compiled/zod/index.js";

/** Upper bound for a single `type` action, in UTF-16 code units. */
export const MAX_TYPE_LENGTH = 4_096;
/** Upper bound for a single `wait` or `hold_key` action, in milliseconds. */
export const MAX_DURATION_MS = 30_000;
/** Upper bound for one scroll action, in wheel clicks. */
export const MAX_SCROLL_AMOUNT = 25;
/** Upper bound for a screen coordinate, in pixels. */
export const MAX_COORDINATE = 32_767;

const coordinate = z
  .tuple([z.number().int().min(0).max(MAX_COORDINATE), z.number().int().min(0).max(MAX_COORDINATE)])
  .describe("Pixel coordinate as [x, y], measured from the top-left of the screenshot.");

const keys = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "A key chord in xdotool notation, e.g. `Return`, `ctrl+s`, `alt+Tab`. Combine keys with `+`.",
  );

const modifiers = z
  .array(z.string().min(1).max(32))
  .max(4)
  .optional()
  .describe('Modifier keys held for the duration of the click, e.g. ["ctrl"].');

/**
 * The model-facing action union. Names follow the widely implemented
 * computer-use vocabulary so a model trained on it needs no translation
 * layer, and every eve computer backend implements the same set.
 */
export const COMPUTER_ACTION_SCHEMA = z.discriminatedUnion("action", [
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("cursor_position") }),
  z.object({ action: z.literal("screen_size") }),
  z.object({ action: z.literal("mouse_move"), coordinate }),
  z.object({ action: z.literal("left_click"), coordinate: coordinate.optional(), modifiers }),
  z.object({ action: z.literal("right_click"), coordinate: coordinate.optional(), modifiers }),
  z.object({ action: z.literal("middle_click"), coordinate: coordinate.optional(), modifiers }),
  z.object({ action: z.literal("double_click"), coordinate: coordinate.optional(), modifiers }),
  z.object({ action: z.literal("triple_click"), coordinate: coordinate.optional(), modifiers }),
  z.object({ action: z.literal("left_mouse_down"), coordinate: coordinate.optional() }),
  z.object({ action: z.literal("left_mouse_up"), coordinate: coordinate.optional() }),
  z.object({
    action: z.literal("left_click_drag"),
    from: coordinate.optional(),
    to: coordinate,
  }),
  z.object({
    action: z.literal("scroll"),
    coordinate: coordinate.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(MAX_SCROLL_AMOUNT),
  }),
  z.object({ action: z.literal("type"), text: z.string().min(1).max(MAX_TYPE_LENGTH) }),
  z.object({ action: z.literal("key"), keys }),
  z.object({
    action: z.literal("hold_key"),
    keys,
    durationMs: z.number().int().min(1).max(MAX_DURATION_MS),
  }),
  z.object({
    action: z.literal("wait"),
    durationMs: z.number().int().min(1).max(MAX_DURATION_MS),
  }),
]);

export type ComputerAction = z.infer<typeof COMPUTER_ACTION_SCHEMA>;
export type ComputerActionName = ComputerAction["action"];

/** A screenshot produced by a backend, already encoded for the durable JSON boundary. */
export interface ComputerScreenshot {
  /** Base64-encoded image bytes. */
  readonly base64: string;
  readonly height: number;
  /** IANA media type, e.g. `image/png`. */
  readonly mediaType: string;
  readonly width: number;
}

/** A point in screen pixels, measured from the top-left corner. */
export interface ComputerPoint {
  readonly x: number;
  readonly y: number;
}

/** The result of one {@link ComputerAction}. Every field is action-dependent. */
export interface ComputerActionResult {
  readonly cursor?: ComputerPoint;
  readonly screen?: { readonly height: number; readonly width: number };
  readonly screenshot?: ComputerScreenshot;
  /** A short human-readable confirmation for actions with no other output. */
  readonly text?: string;
}

/** Actions that never mutate the machine, so they are safe to auto-approve. */
export const READ_ONLY_COMPUTER_ACTIONS: ReadonlySet<ComputerActionName> = new Set([
  "screenshot",
  "cursor_position",
  "screen_size",
  "wait",
]);

export function isReadOnlyComputerAction(action: ComputerActionName): boolean {
  return READ_ONLY_COMPUTER_ACTIONS.has(action);
}
