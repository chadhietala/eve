import { conditionalObjectMemoryStore } from "#runtime/memory/conditional-object-store.js";
import {
  type ObjectInfo,
  type ObjectStore,
  ObjectConflictError,
} from "#runtime/memory/object-store.js";
import type { MemoryStore } from "#runtime/memory/store.js";

/**
 * Thrown by {@link S3Client.putObject} when a conditional precondition fails
 * (`If-Match` mismatch or `If-None-Match: *` on an existing key — S3 returns
 * HTTP 412 `PreconditionFailed`). The wiring maps the SDK error to this so the
 * store can surface an {@link ObjectConflictError}.
 */
export class S3PreconditionError extends Error {
  /** The object's current ETag, when the SDK reports it. */
  readonly currentEtag: string | null;
  constructor(currentEtag: string | null = null) {
    super("S3 conditional put precondition failed.");
    this.name = "S3PreconditionError";
    this.currentEtag = currentEtag;
  }
}

/**
 * The narrow slice of an S3-compatible client the store drives, so `eve` takes
 * no `@aws-sdk/client-s3` runtime dependency. A host wires it (see
 * {@link s3MemoryStore}); the same interface serves any S3-compatible bucket,
 * whose `PutObject` supports `If-Match` / `If-None-Match`.
 */
export interface S3Client {
  /** Gets an object's bytes and ETag, or `null` when absent (404). */
  getObject(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  /** Gets an object's ETag, or `null` when absent. */
  headObject(key: string): Promise<string | null>;
  /**
   * Conditionally puts, returning the new ETag. `ifNoneMatch: "*"` succeeds only
   * if the key is absent; `ifMatch` succeeds only if the current ETag matches;
   * neither is unconditional. A failed precondition throws
   * {@link S3PreconditionError}.
   */
  putObject(
    key: string,
    bytes: Uint8Array,
    condition: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<string>;
  /** Deletes an object. A no-op when absent. */
  deleteObject(key: string): Promise<void>;
  /** Lists objects under `prefix`. `modifiedAt` is an ISO-8601 timestamp. */
  listObjects(
    prefix: string,
  ): Promise<readonly { key: string; size: number; modifiedAt: string; etag: string }[]>;
}

/** Options for {@link S3ObjectStore}. */
export interface S3MemoryStoreOptions {
  /** Key prefix every object lands under. Defaults to `memory/`. */
  readonly prefix?: string;
}

/**
 * A {@link ObjectStore} over an S3-compatible bucket, so
 * {@link import("./conditional-object-store.js").conditionalObjectMemoryStore}
 * can back a durable, multi-writer store with it.
 *
 * Compare-and-swap rides S3's native conditional writes — a create uses
 * `If-None-Match: *`, an update uses `If-Match: <etag>` — and a precondition
 * failure becomes an {@link ObjectConflictError}. Object versions are the S3
 * ETag.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(client: S3Client, options: S3MemoryStoreOptions = {}) {
    this.#client = client;
    this.#prefix = normalizePrefix(options.prefix ?? "memory/");
  }

  async get(key: string): Promise<{ bytes: Uint8Array; version: string } | null> {
    const object = await this.#client.getObject(this.#prefix + key);
    return object === null ? null : { bytes: object.bytes, version: object.etag };
  }

  async head(key: string): Promise<string | null> {
    return this.#client.headObject(this.#prefix + key);
  }

  async put(key: string, bytes: Uint8Array, expectedVersion?: string | null): Promise<string> {
    const condition =
      expectedVersion === undefined
        ? {}
        : expectedVersion === null
          ? { ifNoneMatch: "*" as const }
          : { ifMatch: expectedVersion };
    try {
      return await this.#client.putObject(this.#prefix + key, bytes, condition);
    } catch (error) {
      if (error instanceof S3PreconditionError) {
        throw new ObjectConflictError(key, expectedVersion ?? null, error.currentEtag);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.deleteObject(this.#prefix + key);
  }

  async list(prefix: string): Promise<readonly ObjectInfo[]> {
    const objects = await this.#client.listObjects(this.#prefix + prefix);
    return objects.map((object) => ({
      key: object.key.slice(this.#prefix.length),
      size: object.size,
      modifiedAt: object.modifiedAt,
      version: object.etag,
    }));
  }
}

/**
 * A durable, multi-writer {@link MemoryStore} backed by an S3-compatible bucket.
 * Compare-and-swap rides S3's native conditional writes; version history is
 * recorded as sidecar objects.
 *
 * Wire the {@link S3Client} to `@aws-sdk/client-s3` (the `eve` package does not
 * depend on it), mapping a 412 to {@link S3PreconditionError}:
 *
 * ```ts
 * import { PutObjectCommand, S3 } from "@aws-sdk/client-s3";
 * import { defineMemory, s3MemoryStore, S3PreconditionError, type S3Client } from "eve/memory";
 *
 * const s3 = new S3({ region });
 * const client: S3Client = {
 *   async putObject(Key, body, { ifMatch, ifNoneMatch }) {
 *     try {
 *       const r = await s3.send(
 *         new PutObjectCommand({ Bucket, Key, Body: body, IfMatch: ifMatch, IfNoneMatch: ifNoneMatch }),
 *       );
 *       return r.ETag!;
 *     } catch (e) {
 *       if (e?.$metadata?.httpStatusCode === 412) throw new S3PreconditionError();
 *       throw e;
 *     }
 *   },
 *   // getObject / headObject / deleteObject / listObjects → the matching commands
 * };
 *
 * defineMemory({ stores: { notes: { backend: s3MemoryStore(client) } } });
 * ```
 */
export function s3MemoryStore(client: S3Client, options: S3MemoryStoreOptions = {}): MemoryStore {
  return conditionalObjectMemoryStore(new S3ObjectStore(client, options));
}

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) {
    return "";
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
