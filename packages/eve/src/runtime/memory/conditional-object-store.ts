import { type ObjectStore, ObjectConflictError } from "#runtime/memory/object-store.js";
import {
  MemoryConflictError,
  type MemoryStore,
  type MemoryWriteOptions,
} from "#runtime/memory/store.js";
import type { MemoryEntry, MemoryVersion, WriteKey } from "#runtime/memory/types.js";

/** Infix marking a path's version sidecar objects; reserved, filtered from listings. */
const VERSIONS_INFIX = ".versions/";

/**
 * A {@link MemoryStore} backed by an {@link ObjectStore}'s conditional writes —
 * the durable, multi-writer-safe backend for production.
 *
 * Compare-and-swap is delegated to the object store's atomic precondition
 * ({@link MemoryWriteOptions.expectedVersion} maps straight to `If-Match` /
 * `If-None-Match`), so concurrent writers across hosts cannot both win the head —
 * closing the read-then-write race a filesystem backend can only narrow. Version
 * tokens are the object store's (an ETag for a real backend), obtained via
 * {@link ConditionalObjectMemoryStore.head}.
 *
 * Each content-changing write also records an immutable snapshot at a version
 * sidecar key (`<path>.versions/<version>`) for the history trail, mirroring the
 * filesystem backend. Idempotency is content-based: because callers derive write
 * keys from content, a replayed write produces identical bytes and is a no-op
 * against the same head — so no separate applied-key ledger is needed.
 */
export class ConditionalObjectMemoryStore implements MemoryStore {
  readonly #store: ObjectStore;

  constructor(store: ObjectStore) {
    this.#store = store;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const object = await this.#store.get(path);
    return object === null ? null : object.bytes;
  }

  async head(path: string): Promise<string | null> {
    return this.#store.head(path);
  }

  async write(
    path: string,
    bytes: Uint8Array,
    _key: WriteKey,
    options?: MemoryWriteOptions,
  ): Promise<void> {
    let version: string;
    try {
      version = await this.#store.put(path, bytes, options?.expectedVersion);
    } catch (error) {
      if (error instanceof ObjectConflictError) {
        throw new MemoryConflictError(path, error.expected, error.actual);
      }
      throw error;
    }

    // Record the immutable snapshot. Create-if-absent so an identical revision
    // (same content ⇒ same version) is not rewritten and records no new version.
    try {
      await this.#store.put(versionKey(path, version), bytes, null);
    } catch (error) {
      if (!(error instanceof ObjectConflictError)) {
        throw error;
      }
    }
  }

  async list(prefix: string): Promise<MemoryEntry[]> {
    const infos = await this.#store.list(prefix);
    return infos
      .filter((info) => !info.key.includes(VERSIONS_INFIX))
      .map((info) => ({ path: info.key, size: info.size, modifiedAt: info.modifiedAt }));
  }

  async remove(path: string, _key: WriteKey): Promise<void> {
    await this.#store.delete(path);
  }

  async listVersions(path: string): Promise<readonly MemoryVersion[]> {
    const prefix = `${path}${VERSIONS_INFIX}`;
    const infos = await this.#store.list(prefix);
    return infos
      .map((info) => ({ version: info.key.slice(prefix.length), modifiedAt: info.modifiedAt }))
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
  }

  async readVersion(path: string, version: string): Promise<Uint8Array | null> {
    const object = await this.#store.get(versionKey(path, version));
    return object === null ? null : object.bytes;
  }
}

/**
 * Wraps an {@link ObjectStore} as a durable, multi-writer-safe {@link MemoryStore}:
 *
 * ```ts
 * defineMemory({ stores: { notes: { backend: conditionalObjectMemoryStore(s3) } } });
 * ```
 */
export function conditionalObjectMemoryStore(store: ObjectStore): MemoryStore {
  return new ConditionalObjectMemoryStore(store);
}

function versionKey(path: string, version: string): string {
  return `${path}${VERSIONS_INFIX}${version}`;
}
