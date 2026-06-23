import {
  assertSafeSessionId,
  type TranscriptInfo,
  type TranscriptStore,
  type TranscriptTurn,
  type TranscriptWindow,
  withinWindow,
} from "#runtime/transcripts/store.js";

/**
 * The narrow slice of the global `fetch` the store calls: a request in, a
 * `Response` out. Declaring this (rather than `typeof fetch`) lets a test pass a
 * plain fake without the extra `preconnect` property — and without a double cast.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * A durable {@link TranscriptStore} backed by Vercel Blob — the production
 * default on Vercel, wrapping the Blob REST API over the built-in `fetch` so eve
 * takes on no `@vercel/blob` runtime dependency (AGENTS.md principle 3).
 *
 * Blob objects are immutable, so a session's transcript is stored as one small
 * blob per turn at `<prefix><sessionId>/<seq>.json` (content `{ t, v }`). A
 * windowed listing groups blobs by session and derives `createdAt`/`updatedAt`
 * from blob upload times; a read fetches each turn blob and orders by `t`;
 * retention deletes a session's blobs.
 *
 * Both `fetch` and the clock are injectable so the wrapper is unit-tested
 * against a fake transport with no network. Auth defaults to the standard
 * `BLOB_READ_WRITE_TOKEN` env; pass an explicit `token` to override.
 */
export class VercelBlobTranscriptStore implements TranscriptStore {
  readonly #prefix: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #apiBase: string;
  #seq = 0;

  constructor(options: VercelBlobTranscriptStoreOptions = {}) {
    this.#prefix = normalizePrefix(options.prefix ?? "transcripts/");
    this.#token = options.token ?? process.env.BLOB_READ_WRITE_TOKEN ?? "";
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#apiBase = options.apiBase ?? "https://blob.vercel-storage.com";
  }

  async append(sessionId: string, turn: TranscriptTurn): Promise<void> {
    assertSafeSessionId(sessionId);
    const at = this.#now();
    const seq = this.#nextSeq();
    const pathname = `${this.#prefix}${sessionId}/${at}-${seq}.json`;
    const body = JSON.stringify({ t: at, v: turn });

    const response = await this.#fetch(`${this.#apiBase}/${pathname}`, {
      method: "PUT",
      headers: { ...this.#authHeaders(), "content-type": "application/json" },
      body,
    });
    await this.#ensureOk(response, `append to "${sessionId}"`);
  }

  async list(window?: TranscriptWindow): Promise<readonly TranscriptInfo[]> {
    const blobs = await this.#listBlobs(this.#prefix);
    const infos: TranscriptInfo[] = [];
    for (const session of groupBySession(blobs, this.#prefix).values()) {
      if (!withinWindow(session.updatedAt, window)) {
        continue;
      }
      infos.push({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turns: session.blobs.length,
      });
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : 1));
    return infos;
  }

  async read(sessionId: string): Promise<readonly TranscriptTurn[] | null> {
    assertSafeSessionId(sessionId);
    const blobs = await this.#listBlobs(`${this.#prefix}${sessionId}/`);
    if (blobs.length === 0) {
      return null;
    }
    const lines: { t: number; v: TranscriptTurn }[] = [];
    for (const blob of blobs) {
      const response = await this.#fetch(blob.url);
      await this.#ensureOk(response, `read blob "${blob.pathname}"`);
      lines.push((await response.json()) as { t: number; v: TranscriptTurn });
    }
    lines.sort((a, b) => a.t - b.t);
    return lines.map((line) => line.v);
  }

  async prune(olderThan: number): Promise<{ readonly removed: number }> {
    const blobs = await this.#listBlobs(this.#prefix);
    const urls: string[] = [];
    let removed = 0;
    for (const session of groupBySession(blobs, this.#prefix).values()) {
      if (session.updatedAt < olderThan) {
        urls.push(...session.blobs.map((blob) => blob.url));
        removed += 1;
      }
    }
    if (urls.length > 0) {
      const response = await this.#fetch(`${this.#apiBase}/delete`, {
        method: "POST",
        headers: { ...this.#authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      await this.#ensureOk(response, "prune");
    }
    return { removed };
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, "x-api-version": "11" };
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
          uploadedAt: Date.parse(blob.uploadedAt),
        });
      }
      cursor = page.hasMore === true ? page.cursor : undefined;
    } while (cursor !== undefined);
    return entries;
  }

  async #ensureOk(response: { ok: boolean; status: number }, what: string): Promise<void> {
    if (!response.ok) {
      throw new Error(`Vercel Blob ${what} failed with status ${response.status}.`);
    }
  }
}

/** Options for {@link VercelBlobTranscriptStore}. */
export interface VercelBlobTranscriptStoreOptions {
  /** Key prefix every transcript blob lands under. Defaults to `transcripts/`. */
  readonly prefix?: string;
  /** Read/write token; defaults to `process.env.BLOB_READ_WRITE_TOKEN`. */
  readonly token?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock returning epoch-ms; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Override the API base (for tests/self-hosting). */
  readonly apiBase?: string;
}

/**
 * Factory for a Vercel-Blob-backed {@link TranscriptStore}, the production
 * default. Reads `BLOB_READ_WRITE_TOKEN` from the environment unless a `token`
 * is supplied.
 */
export function vercelBlobTranscriptStore(
  options: VercelBlobTranscriptStoreOptions = {},
): TranscriptStore {
  return new VercelBlobTranscriptStore(options);
}

interface BlobEntry {
  readonly pathname: string;
  readonly url: string;
  readonly uploadedAt: number;
}

interface BlobListResponse {
  readonly blobs?: readonly { pathname: string; url: string; uploadedAt: string }[];
  readonly cursor?: string;
  readonly hasMore?: boolean;
}

interface SessionGroup {
  readonly sessionId: string;
  createdAt: number;
  updatedAt: number;
  readonly blobs: BlobEntry[];
}

function groupBySession(blobs: readonly BlobEntry[], prefix: string): Map<string, SessionGroup> {
  const groups = new Map<string, SessionGroup>();
  for (const blob of blobs) {
    const sessionId = sessionIdOf(blob.pathname, prefix);
    if (sessionId === null) {
      continue;
    }
    const group = groups.get(sessionId);
    if (group === undefined) {
      groups.set(sessionId, {
        sessionId,
        createdAt: blob.uploadedAt,
        updatedAt: blob.uploadedAt,
        blobs: [blob],
      });
      continue;
    }
    group.blobs.push(blob);
    group.createdAt = Math.min(group.createdAt, blob.uploadedAt);
    group.updatedAt = Math.max(group.updatedAt, blob.uploadedAt);
  }
  return groups;
}

/** Recovers `<sessionId>` from a `<prefix><sessionId>/<turn>.json` pathname. */
function sessionIdOf(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? null : rest.slice(0, slash);
}

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) {
    return "";
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
