import type { MemoryEntry, MemoryVersion, WriteKey } from "#runtime/memory/types.js";
import { sha256 } from "#runtime/memory/write-key.js";

/**
 * Thrown by {@link MemoryStore.write} when a compare-and-swap precondition
 * fails: the caller passed an `expectedVersion` that no longer matches the
 * path's current head version, so writing would clobber an interleaving change.
 *
 * The {@link MemoryStore.write} caller is expected to re-read the head,
 * recompute its `expectedVersion`, and retry — that is the conflict-aware
 * last-write-wins loop the file-tool redirect implements.
 */
export class MemoryConflictError extends Error {
  /** The store-relative path whose head moved out from under the writer. */
  readonly path: string;
  /** The version the writer expected the head to be (`null` = expected-absent). */
  readonly expected: string | null;
  /** The version the head actually was at write time (`null` = absent). */
  readonly actual: string | null;

  constructor(path: string, expected: string | null, actual: string | null) {
    super(
      `Memory write to "${path}" conflicts: expected version ${expected ?? "(absent)"}, found ${actual ?? "(absent)"}.`,
    );
    this.name = "MemoryConflictError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Optional per-write controls for {@link MemoryStore.write}.
 */
export interface MemoryWriteOptions {
  /**
   * Compare-and-swap precondition. When provided, the write only proceeds if the
   * path's current head version equals `expectedVersion`; otherwise it throws
   * {@link MemoryConflictError}. The token is backend-defined and obtained from
   * {@link MemoryStore.head} (`sha256(content)` for the built-in stores, the
   * object ETag for an object-store backend); the head of an absent path is
   * `null`. Omit for an unconditional (blind) write.
   */
  readonly expectedVersion?: string | null;
}

/**
 * The eve-owned durable memory backend, presented as a small POSIX-like
 * object store keyed by logical path.
 *
 * Writes and removals carry a deterministic {@link WriteKey}: applying the
 * same key twice is a no-op, so a workflow replay that re-issues the same
 * logical mutation does not double-apply it. This is the idempotency contract
 * that makes working-memory writes safe to run inside a durable turn step.
 *
 * Every write that CHANGES content also records an immutable {@link
 * MemoryVersion} (a full audit trail). The live path is the head; older
 * revisions are read back via {@link MemoryStore.readVersion}. There is no
 * dedicated restore call — restore is "read an old version, write it back",
 * which records a fresh head version equal to the old content.
 *
 * Implementations include {@link InMemoryMemoryStore} (tests, dev) and {@link
 * FsMemoryStore} (the real filesystem), behind this same interface — mirroring
 * the pluggable `SandboxBackend`.
 */
export interface MemoryStore {
  /**
   * Reads the latest bytes at `path`, or `null` if absent.
   */
  read(path: string): Promise<Uint8Array | null>;

  /**
   * Returns the path's current head version token, or `null` when absent.
   *
   * This is the token a caller passes back as `expectedVersion` to compare-and-
   * swap without recomputing it — so conflict-aware writes stay backend-agnostic
   * (the built-in stores return `sha256(content)`; an object store returns the
   * ETag its conditional write conditions on).
   */
  head(path: string): Promise<string | null>;

  /**
   * Writes `bytes` to `path` under `key` (PUT semantics).
   *
   * Idempotent: re-applying a `key` already seen is a no-op, even if `bytes`
   * differ — the first write under a key wins, matching deterministic replay.
   * An idempotent no-op records no new version.
   *
   * When `options.expectedVersion` is provided it is a compare-and-swap
   * precondition: the write throws {@link MemoryConflictError} unless the
   * path's current head version equals it (head version of an absent path is
   * `null`). When omitted, the write is unconditional.
   *
   * A successful write that changes content records a new {@link
   * MemoryVersion}; writing bytes identical to the current head records none.
   */
  write(
    path: string,
    bytes: Uint8Array,
    key: WriteKey,
    options?: MemoryWriteOptions,
  ): Promise<void>;

  /**
   * Lists entries whose path starts with `prefix`.
   */
  list(prefix: string): Promise<MemoryEntry[]>;

  /**
   * Removes `path` under `key`.
   *
   * Idempotent in the same sense as {@link MemoryStore.write}: re-applying a
   * seen `key` is a no-op.
   */
  remove(path: string, key: WriteKey): Promise<void>;

  /**
   * Lists the immutable version history of `path`, newest first. Empty when the
   * path was never written.
   */
  listVersions(path: string): Promise<readonly MemoryVersion[]>;

  /**
   * Reads the bytes of a specific historical `version` of `path`, or `null`
   * when no such version exists. Restore = read an old version with this, then
   * {@link MemoryStore.write} the bytes back.
   */
  readVersion(path: string, version: string): Promise<Uint8Array | null>;
}

interface StoredEntry {
  readonly bytes: Uint8Array;
  readonly modifiedAt: string;
  /** Immutable revisions of this path, newest first. */
  readonly versions: VersionRecord[];
}

interface VersionRecord {
  readonly version: string;
  readonly modifiedAt: string;
  readonly bytes: Uint8Array;
}

/**
 * In-memory {@link MemoryStore} for tests, dev, and reuse by higher layers.
 *
 * Holds entries in a `Map` keyed by path and tracks every applied
 * {@link WriteKey} so idempotency is enforced exactly as a durable backend
 * must. Each entry carries its full version list in memory. Timestamps are
 * caller-injected (via `now`) so journal/replay tests stay deterministic and
 * clock-free.
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #appliedKeys = new Set<WriteKey>();
  readonly #now: () => string;

  /**
   * @param now Injectable clock returning an ISO-8601 timestamp for write
   *   modification times. Defaults to a fixed epoch so tests are deterministic
   *   unless they opt into a clock.
   */
  constructor(now: () => string = () => "1970-01-01T00:00:00.000Z") {
    this.#now = now;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(path);
    return entry === undefined ? null : entry.bytes;
  }

  async head(path: string): Promise<string | null> {
    const entry = this.#entries.get(path);
    return entry === undefined ? null : sha256(entry.bytes);
  }

  async write(
    path: string,
    bytes: Uint8Array,
    key: WriteKey,
    options?: MemoryWriteOptions,
  ): Promise<void> {
    if (this.#appliedKeys.has(key)) {
      return;
    }

    const current = this.#entries.get(path);
    const head = current === undefined ? null : sha256(current.bytes);

    if (options?.expectedVersion !== undefined && options.expectedVersion !== head) {
      // CAS precondition failed — the head moved since the caller read it.
      // Do NOT record the key, so the caller can retry with a fresh expectation.
      throw new MemoryConflictError(path, options.expectedVersion, head);
    }

    this.#appliedKeys.add(key);

    const version = sha256(bytes);
    // Writing the same content the head already holds is a no-op for the audit
    // trail: it records no new version (but still consumes the write key).
    if (head === version && current !== undefined) {
      return;
    }

    const modifiedAt = this.#now();
    const versions = current === undefined ? [] : current.versions;
    versions.unshift({ bytes, modifiedAt, version });
    this.#entries.set(path, { bytes, modifiedAt, versions });
  }

  async list(prefix: string): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    for (const [path, stored] of this.#entries) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      entries.push({ modifiedAt: stored.modifiedAt, path, size: stored.bytes.byteLength });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async remove(path: string, key: WriteKey): Promise<void> {
    if (this.#appliedKeys.has(key)) {
      return;
    }
    this.#appliedKeys.add(key);
    this.#entries.delete(path);
  }

  async listVersions(path: string): Promise<readonly MemoryVersion[]> {
    const entry = this.#entries.get(path);
    if (entry === undefined) {
      return [];
    }
    return entry.versions.map((record) => ({
      modifiedAt: record.modifiedAt,
      version: record.version,
    }));
  }

  async readVersion(path: string, version: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(path);
    if (entry === undefined) {
      return null;
    }
    const record = entry.versions.find((candidate) => candidate.version === version);
    return record === undefined ? null : record.bytes;
  }
}
