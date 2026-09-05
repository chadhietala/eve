import type { ComputerAction, ComputerActionResult } from "#computer/action.js";

/** Ambient information a backend receives with every action. */
export interface ComputerExecuteContext {
  readonly abortSignal: AbortSignal;
}

/**
 * The contract every computer backend implements. One method keeps the
 * remote protocol a pass-through and keeps a new backend to a single
 * `switch`.
 */
export interface ComputerBackend {
  /**
   * Stable identifier used in diagnostics and in the tool description, e.g.
   * `virtual`, `system:linux`, `remote`.
   */
  readonly id: string;
  execute(action: ComputerAction, context: ComputerExecuteContext): Promise<ComputerActionResult>;
}

/**
 * A computer action that could not be carried out. The message is written
 * for the model: it names the missing capability and the concrete next step,
 * because a computer backend fails in ways only the operator can fix.
 */
export class ComputerError extends Error {
  static is(value: unknown): value is ComputerError {
    return value instanceof Error && (value as { [BRAND]?: true })[BRAND] === true;
  }

  override readonly name = "ComputerError";
  /** Machine-readable reason, forwarded across the remote protocol. */
  readonly reason: ComputerErrorReason;

  constructor(reason: ComputerErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
    Object.defineProperty(this, BRAND, { value: true });
  }
}

const BRAND = Symbol.for("eve.computer.error");

export type ComputerErrorReason =
  /** The backend cannot reach a screen or input device at all. */
  | "unavailable"
  /** A required host binary or permission is missing. */
  | "unsupported"
  /** The action was rejected by validation or a bound. */
  | "invalid"
  /** The remote host refused the request. */
  | "unauthorized"
  /** The action started but did not complete. */
  | "failed";

export function defineComputerBackend<const T extends ComputerBackend>(backend: T): T {
  return backend;
}
