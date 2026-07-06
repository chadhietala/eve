import { conditionalObjectMemoryStore } from "#runtime/memory/conditional-object-store.js";
import {
  type ObjectInfo,
  type ObjectStore,
  ObjectConflictError,
} from "#runtime/memory/object-store.js";
import type { MemoryStore } from "#runtime/memory/store.js";

/**
 * The narrow slice of `fetch` this store calls. Declaring it (rather than
 * `typeof fetch`) lets a test pass a plain fake transport.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options for {@link VercelBlobObjectStore}. */
export interface VercelBlobMemoryStoreOptions {
  /** Key prefix every object lands under. Defaults to `memory/`. */
  readonly prefix?: string;
  /** Read/write token; defaults to `process.env.BLOB_READ_WRITE_TOKEN`. */
  readonly token?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Object access level. Defaults to `"private"` (memory is not public). */
  readonly access?: "public" | "private";
  /** Override the API base (for tests/self-hosting). */
  readonly apiBase?: string;
}

/**
 * A {@link ObjectStore} over the Vercel Blob REST API, so
 * {@link import("./conditional-object-store.js").conditionalObjectMemoryStore}
 * can back a durable, multi-writer store with Vercel Blob.
 *
 * Blob's native conditional writes carry the compare-and-swap: a create sends
 * `x-allow-overwrite: 0` (fail if present), an update sends `x-if-match: <etag>`,
 * and a precondition failure (HTTP 409/412) becomes an
 * {@link ObjectConflictError}. Object versions are the blob ETag. Talking to the
 * REST API over an injected `fetch` (rather than `@vercel/blob`) keeps `eve` free
 * of a runtime dependency and makes the store unit-testable against a fake
 * transport.
 */
export class VercelBlobObjectStore implements ObjectStore {
  readonly #prefix: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #access: "public" | "private";
  readonly #apiBase: string;

  constructor(options: VercelBlobMemoryStoreOptions = {}) {
    this.#prefix = normalizePrefix(options.prefix ?? "memory/");
    this.#token = options.token ?? process.env.BLOB_READ_WRITE_TOKEN ?? "";
    this.#fetch = options.fetch ?? fetch;
    this.#access = options.access ?? "private";
    this.#apiBase = options.apiBase ?? "https://blob.vercel-storage.com";
  }

  async get(key: string): Promise<{ bytes: Uint8Array; version: string } | null> {
    const blob = await this.#find(key);
    if (blob === null) {
      return null;
    }
    const response = await this.#fetch(blob.url, { headers: this.#authHeaders() });
    if (response.status === 404) {
      return null;
    }
    await this.#ensureOk(response, `get "${key}"`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), version: blob.version };
  }

  async head(key: string): Promise<string | null> {
    return (await this.#find(key))?.version ?? null;
  }

  async put(key: string, bytes: Uint8Array, expectedVersion?: string | null): Promise<string> {
    const headers: Record<string, string> = {
      ...this.#authHeaders(),
      "x-content-type": "application/octet-stream",
      "x-vercel-blob-access": this.#access,
    };
    if (expectedVersion === undefined) {
      headers["x-allow-overwrite"] = "1";
    } else if (expectedVersion === null) {
      headers["x-allow-overwrite"] = "0"; // create-if-absent
    } else {
      headers["x-allow-overwrite"] = "1";
      headers["x-if-match"] = expectedVersion; // update-if-unchanged
    }

    const response = await this.#fetch(`${this.#apiBase}/${this.#prefix}${key}`, {
      method: "PUT",
      headers,
      body: bytes,
    });
    if (response.status === 409 || response.status === 412) {
      throw new ObjectConflictError(key, expectedVersion ?? null, response.headers.get("etag"));
    }
    await this.#ensureOk(response, `put "${key}"`);
    // Keep the ETag verbatim — it round-trips as `x-if-match` on the next update,
    // so it must match exactly what the API compares against.
    return response.headers.get("etag") ?? (await this.#etagFromBody(response));
  }

  async delete(key: string): Promise<void> {
    const blob = await this.#find(key);
    if (blob === null) {
      return;
    }
    const response = await this.#fetch(`${this.#apiBase}/delete`, {
      method: "POST",
      headers: { ...this.#authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ urls: [blob.url] }),
    });
    await this.#ensureOk(response, `delete "${key}"`);
  }

  async list(prefix: string): Promise<readonly ObjectInfo[]> {
    const blobs = await this.#listBlobs(`${this.#prefix}${prefix}`);
    return blobs.map((blob) => ({
      key: blob.pathname.slice(this.#prefix.length),
      size: blob.size,
      modifiedAt: blob.uploadedAt,
      version: blob.version,
    }));
  }

  /** Resolves one blob by exact key via a prefix listing (its url + ETag). */
  async #find(key: string): Promise<BlobEntry | null> {
    const target = `${this.#prefix}${key}`;
    for (const blob of await this.#listBlobs(target)) {
      if (blob.pathname === target) {
        return blob;
      }
    }
    return null;
  }

  async #listBlobs(prefix: string): Promise<BlobEntry[]> {
    const entries: BlobEntry[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(this.#apiBase);
      url.searchParams.set("prefix", prefix);
      if (cursor !== undefined) {
        url.searchParams.set("cursor", cursor);
      }
      const response = await this.#fetch(url.toString(), { headers: this.#authHeaders() });
      await this.#ensureOk(response, "list");
      const page = (await response.json()) as BlobListResponse;
      for (const blob of page.blobs ?? []) {
        entries.push({
          pathname: blob.pathname,
          url: blob.url,
          size: blob.size ?? 0,
          uploadedAt: blob.uploadedAt,
          version: blob.etag ?? "",
        });
      }
      cursor = page.hasMore === true ? page.cursor : undefined;
    } while (cursor !== undefined);
    return entries;
  }

  #authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, "x-api-version": "12" };
  }

  async #etagFromBody(response: Response): Promise<string> {
    const body = (await response.json()) as { etag?: string };
    return body.etag ?? "";
  }

  async #ensureOk(response: { ok: boolean; status: number }, what: string): Promise<void> {
    if (!response.ok) {
      throw new Error(`Vercel Blob ${what} failed with status ${response.status}.`);
    }
  }
}

/**
 * A durable, multi-writer {@link MemoryStore} backed by Vercel Blob. Its
 * compare-and-swap rides Blob's native conditional writes, and version history
 * is recorded as sidecar objects.
 *
 * ```ts
 * import { defineMemory, vercelBlobMemoryStore } from "eve/memory";
 *
 * defineMemory({ stores: { notes: { backend: vercelBlobMemoryStore() } } });
 * ```
 *
 * Reads `BLOB_READ_WRITE_TOKEN` from the environment unless a `token` is supplied.
 */
export function vercelBlobMemoryStore(options: VercelBlobMemoryStoreOptions = {}): MemoryStore {
  return conditionalObjectMemoryStore(new VercelBlobObjectStore(options));
}

interface BlobEntry {
  readonly pathname: string;
  readonly url: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly version: string;
}

interface BlobListResponse {
  readonly blobs?: readonly {
    pathname: string;
    url: string;
    size?: number;
    uploadedAt: string;
    etag?: string;
  }[];
  readonly cursor?: string;
  readonly hasMore?: boolean;
}

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) {
    return "";
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
