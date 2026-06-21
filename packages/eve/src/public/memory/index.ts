/**
 * Memory authoring helpers for an agent's `memory.{md,ts}` file and for custom
 * store backends.
 *
 * Author the memory layer with {@link defineMemory}, back a store with the
 * built-in {@link fsStore} or your own {@link MemoryStore} implementation, and
 * (optionally) configure consolidation with {@link DreamConfig}.
 */

export {
  defineMemory,
  type DreamConfig,
  type DreamContext,
  type DreamMemoryAccess,
  type MemoryDefinition,
  type StoreMount,
} from "#public/definitions/memory.js";

export { fsStore } from "#runtime/memory/fs-store.js";

export {
  MemoryConflictError,
  type MemoryStore,
  type MemoryWriteOptions,
} from "#runtime/memory/store.js";

export {
  type MemoryEntry,
  type MemoryNamespace,
  type MemoryVersion,
  type WriteKey,
} from "#runtime/memory/types.js";
