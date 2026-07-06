/**
 * Memory authoring helpers for an agent's `memory.{md,ts}` file and for custom
 * store backends.
 *
 * Author the memory layer with {@link defineMemory}, back a store with the
 * built-in {@link fsStore} or your own {@link MemoryStore} implementation, and
 * (optionally) configure dream with {@link DreamConfig}.
 */

export {
  defineMemory,
  type Duration,
  type DreamConfig,
  type DreamContext,
  type DreamMemoryAccess,
  type MemoryDefinition,
  type StoreMount,
  type TranscriptConfig,
  type TranscriptRetention,
} from "#public/definitions/memory.js";

export { fsStore } from "#runtime/memory/fs-store.js";

export { conditionalObjectMemoryStore } from "#runtime/memory/conditional-object-store.js";

export {
  InMemoryObjectStore,
  ObjectConflictError,
  type ObjectInfo,
  type ObjectStore,
} from "#runtime/memory/object-store.js";

export {
  MemoryConflictError,
  type MemoryStore,
  type MemoryWriteOptions,
} from "#runtime/memory/store.js";

export { fsTranscriptStore } from "#runtime/transcripts/fs-store.js";

export {
  type TranscriptInfo,
  type TranscriptStore,
  type TranscriptTurn,
  type TranscriptWindow,
} from "#runtime/transcripts/store.js";

export {
  vercelBlobTranscriptStore,
  type VercelBlobTranscriptStoreOptions,
} from "#runtime/transcripts/vercel-blob-store.js";

export { type MemoryEntry, type MemoryVersion, type WriteKey } from "#runtime/memory/types.js";
