import { sha256 } from "#runtime/memory/write-key.js";

/**
 * Metadata for one stored object, as returned by a prefix listing.
 *
 * `version` is the object's opaque head token (the ETag for a real object store,
 * a content hash for the in-memory one) — the same value {@link ObjectStore.head}
 * returns and {@link ObjectStore.put} conditions on.
 */
export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly version: string;
}

/**
 * Thrown by {@link ObjectStore.put} when its conditional precondition fails: the
 * caller passed an `expectedVersion` that no longer matches the key's current
 * head (a concurrent writer moved it, or the key exists/absent against
 * expectation).
 */
export class ObjectConflictError extends Error {
  readonly key: string;
  readonly expected: string | null;
  readonly actual: string | null;

  constructor(key: string, expected: string | null, actual: string | null) {
    super(
      `Object put to "${key}" conflicts: expected version ${expected ?? "(absent)"}, found ${actual ?? "(absent)"}.`,
    );
    this.name = "ObjectConflictError";
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A narrow object store with **conditional writes** — the one primitive a
 * {@link import("./conditional-object-store.js").ConditionalObjectMemoryStore}
 * needs to be multi-writer safe.
 *
 * Adapt a real backend (an S3-compatible bucket, Vercel Blob) to this port; the
 * conditional {@link ObjectStore.put} maps directly to the storage's native
 * preconditions — `If-None-Match: *` for create-if-absent, `If-Match: <etag>`
 * for update-if-unchanged — which are evaluated atomically inside the PUT. That
 * atomicity is what a read-then-write compare-and-swap cannot guarantee across
 * hosts.
 */
export interface ObjectStore {
  /** Reads an object's bytes and head version, or `null` when absent. */
  get(key: string): Promise<{ bytes: Uint8Array; version: string } | null>;

  /** Returns an object's head version token, or `null` when absent. */
  head(key: string): Promise<string | null>;

  /**
   * Conditionally writes `key`, returning the new head version.
   *
   * `expectedVersion` is a tri-state precondition: `undefined` writes
   * unconditionally; `null` succeeds only if the key is absent
   * (`If-None-Match: *`); a string succeeds only if the current head equals it
   * (`If-Match`). A failed precondition throws {@link ObjectConflictError}.
   */
  put(key: string, bytes: Uint8Array, expectedVersion?: string | null): Promise<string>;

  /** Deletes `key`. A no-op when absent. */
  delete(key: string): Promise<void>;

  /** Lists objects whose key starts with `prefix`. */
  list(prefix: string): Promise<readonly ObjectInfo[]>;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly version: string;
  readonly modifiedAt: string;
}

/**
 * In-memory {@link ObjectStore} for tests and dev, modelling a real object
 * store's conditional-write semantics: the version is a content hash (as a
 * simple-PUT ETag is), and {@link InMemoryObjectStore.put} enforces the
 * precondition atomically, so it exercises the same compare-and-swap paths a
 * durable backend would.
 */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, StoredObject>();
  readonly #now: () => string;

  constructor(now: () => string = () => "1970-01-01T00:00:00.000Z") {
    this.#now = now;
  }

  async get(key: string): Promise<{ bytes: Uint8Array; version: string } | null> {
    const object = this.#objects.get(key);
    return object === undefined ? null : { bytes: object.bytes, version: object.version };
  }

  async head(key: string): Promise<string | null> {
    return this.#objects.get(key)?.version ?? null;
  }

  async put(key: string, bytes: Uint8Array, expectedVersion?: string | null): Promise<string> {
    const current = this.#objects.get(key)?.version ?? null;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new ObjectConflictError(key, expectedVersion, current);
    }
    const version = sha256(bytes);
    this.#objects.set(key, { bytes, version, modifiedAt: this.#now() });
    return version;
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async list(prefix: string): Promise<readonly ObjectInfo[]> {
    const infos: ObjectInfo[] = [];
    for (const [key, object] of this.#objects) {
      if (key.startsWith(prefix)) {
        infos.push({
          key,
          size: object.bytes.byteLength,
          modifiedAt: object.modifiedAt,
          version: object.version,
        });
      }
    }
    infos.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return infos;
  }
}
