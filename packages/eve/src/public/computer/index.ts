/**
 * Computer-use authoring helpers.
 *
 * A computer backend is a machine an agent can see and drive. eve owns the
 * action vocabulary, the bounds on each action, and the wire protocol; a
 * backend owns how a screenshot is captured and how input reaches the
 * operating system.
 */
export {
  COMPUTER_ACTION_SCHEMA,
  isReadOnlyComputerAction,
  MAX_COORDINATE,
  MAX_DURATION_MS,
  MAX_SCROLL_AMOUNT,
  MAX_TYPE_LENGTH,
  READ_ONLY_COMPUTER_ACTIONS,
  type ComputerAction,
  type ComputerActionName,
  type ComputerActionResult,
  type ComputerPoint,
  type ComputerScreenshot,
} from "#computer/action.js";
export {
  ComputerError,
  defineComputerBackend,
  type ComputerBackend,
  type ComputerErrorReason,
  type ComputerExecuteContext,
} from "#computer/backend.js";
export { defaultComputerBackend } from "#computer/backends/default.js";
export { remoteComputer, type RemoteComputerOptions } from "#computer/backends/remote.js";
export { systemComputer, type SystemComputerOptions } from "#computer/backends/system.js";
export {
  virtualComputer,
  type VirtualComputer,
  type VirtualComputerActivateContext,
  type VirtualComputerElement,
  type VirtualComputerOptions,
} from "#computer/backends/virtual.js";
export { createComputerHost, type ComputerHostOptions } from "#computer/host.js";
export {
  COMPUTER_ERROR_STATUS,
  COMPUTER_EXECUTE_PATH,
  COMPUTER_INFO_PATH,
  COMPUTER_INFO_SCHEMA,
  COMPUTER_RESPONSE_SCHEMA,
  MAX_REQUEST_BYTES,
  type ComputerInfo,
} from "#computer/protocol.js";
