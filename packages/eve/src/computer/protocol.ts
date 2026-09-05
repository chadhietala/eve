import { z } from "#compiled/zod/index.js";

import { COMPUTER_ACTION_SCHEMA } from "#computer/action.js";
import type { ComputerErrorReason } from "#computer/backend.js";

/** Path suffix for the action endpoint, appended to a host's base URL. */
export const COMPUTER_EXECUTE_PATH = "/v1/execute";
/** Path suffix for the capability endpoint, appended to a host's base URL. */
export const COMPUTER_INFO_PATH = "/v1/info";
/** Maximum accepted request body for the action endpoint, in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1_024;

export const COMPUTER_REQUEST_SCHEMA = z.object({
  action: COMPUTER_ACTION_SCHEMA,
});

const screenshotSchema = z.object({
  base64: z.string().min(1),
  height: z.number().int().positive(),
  mediaType: z.string().min(1),
  width: z.number().int().positive(),
});

const pointSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export const COMPUTER_RESULT_SCHEMA = z.object({
  cursor: pointSchema.optional(),
  screen: z
    .object({ height: z.number().int().positive(), width: z.number().int().positive() })
    .optional(),
  screenshot: screenshotSchema.optional(),
  text: z.string().optional(),
});

export const COMPUTER_ERROR_SCHEMA = z.object({
  message: z.string().min(1),
  reason: z.enum(["unavailable", "unsupported", "invalid", "unauthorized", "failed"]),
});

export const COMPUTER_RESPONSE_SCHEMA = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: COMPUTER_RESULT_SCHEMA }),
  z.object({ ok: z.literal(false), error: COMPUTER_ERROR_SCHEMA }),
]);

export const COMPUTER_INFO_SCHEMA = z.object({
  id: z.string().min(1),
  screen: z.object({
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  }),
});

export type ComputerInfo = z.infer<typeof COMPUTER_INFO_SCHEMA>;

/** HTTP status for each error reason, so a client can retry sensibly. */
export const COMPUTER_ERROR_STATUS: Readonly<Record<ComputerErrorReason, number>> = {
  failed: 500,
  invalid: 400,
  unauthorized: 401,
  unavailable: 503,
  unsupported: 501,
};
