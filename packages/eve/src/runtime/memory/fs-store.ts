import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MemoryConflictError,
  type MemoryStore,
  type MemoryWriteOptions,
} from "#runtime/memory/store.js";
import type { MemoryEntry, MemoryVersion, WriteKey } from "#runtime/memory/types.js";
import { sha256 } from "#runtime/memory/write-key.js";

const DEFAULT_BASE_DIR = ".eve/memory";
const APPLIED_KEYS_FILE = ".applied-keys.json";
/** Suffix of the sidecar directory holding a path's immutable versions. */
const VERSIONS_SUFFIX = ".versions";

/**
 * Maps one logical path segment to a single filesystem-safe segment.
 *
 * Percent-encodes every character outside an unreserved allowlist so that path
 * separators, `..` traversal, and other reserved bytes cannot leak into the
 * on-disk layout. The mapping is total and reversible enough that distinct
 * logical names never collide on a sanitized name.
 */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

function sanitizePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(sanitizeSegment)
    .join("/");
}

/**
 * A durable {@link MemoryStore} backed by the real filesystem.
 *
 * The store is rooted at `baseDir`; each logical path becomes a file under it
 * (every segment sanitized so it is a single, traversal-free path segment).
 * Parent directories are created on write. The `baseDir` is the store's
 * identity — two agents pointing at the same directory share its memory.
 *
 * Idempotency is durable across process restarts: every applied
 * {@link WriteKey} is recorded in a ledger file at the store root
 * (`.applied-keys.json`). A write or removal whose key is already in the ledger
 * is a no-op, so a workflow replay that re-issues the same logical mutation
 * after a restart still does not double-apply it. The data mutation is
 * performed before the ledger is updated, so a crash between the two leaves a
 * key un-recorded (the mutation may re-run, which is safe under PUT/delete
 * semantics) rather than recording a key whose mutation never landed.
 *
 * Versioning is durable too: every write that changes content snapshots the
 * new bytes into a sidecar directory `<path>.versions/<version>` (the version
 * id is `sha256(content)` hex). The live file remains the head; the sidecar is
 * the immutable audit trail read back by {@link FsMemoryStore.listVersions}
 * and {@link FsMemoryStore.readVersion}. Compare-and-swap reads the head
 * file's sha and compares it to the caller's `expectedVersion`.
 *
 * RACE CAVEAT: this store is correct for a single writer/sweeper. CAS is a
 * read-head-then-write sequence, not an atomic OS primitive, so two processes
 * racing the same path can both observe the same head and both write — the
 * second clobbers the first's head but BOTH revisions are preserved in the
 * sidecar (no version is lost, only the head ordering is racy). The intended
 * deployment serializes writers per store; the redirect's bounded CAS retry
 * narrows the window further but does not close it for true concurrent
 * filesystem writers.
 */
export class FsMemoryStore implements MemoryStore {
  readonly #baseDir: string;

  /**
   * @param baseDir Root directory for the store. Defaults to `.eve/memory`
   *   relative to the process working directory. Modification times are derived
   *   from the filesystem `mtime`, so no clock is injected.
   */
  constructor(baseDir: string = DEFAULT_BASE_DIR) {
    this.#baseDir = baseDir;
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(this.#filePath(path));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async write(
    path: string,
    bytes: Uint8Array,
    key: WriteKey,
    options?: MemoryWriteOptions,
  ): Promise<void> {
    const applied = await this.#readAppliedKeys();
    if (applied.has(key)) {
      return;
    }

    const filePath = this.#filePath(path);
    const current = await this.read(path);
    const head = current === null ? null : sha256(current);

    if (options?.expectedVersion !== undefined && options.expectedVersion !== head) {
      // CAS precondition failed — the head moved since the caller read it. Do
      // NOT record the key, so the caller can retry with a fresh expectation.
      throw new MemoryConflictError(path, options.expectedVersion, head);
    }

    const version = sha256(bytes);
    // Writing the content the head already holds changes nothing: record no new
    // version (but still consume the write key below for idempotency).
    if (head !== version) {
      await mkdir(parentOf(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      await this.#recordVersion(filePath, version, bytes);
    }

    applied.add(key);
    await this.#writeAppliedKeys(applied);
  }

  async list(prefix: string): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    await this.#collect("", prefix, entries);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async remove(path: string, key: WriteKey): Promise<void> {
    const applied = await this.#readAppliedKeys();
    if (applied.has(key)) {
      return;
    }

    await rm(this.#filePath(path), { force: true });

    applied.add(key);
    await this.#writeAppliedKeys(applied);
  }

  async listVersions(path: string): Promise<readonly MemoryVersion[]> {
    const versionsDir = `${this.#filePath(path)}${VERSIONS_SUFFIX}`;
    let dirents;
    try {
      dirents = await readdir(versionsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const versions: MemoryVersion[] = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) {
        continue;
      }
      const fileStat = await stat(join(versionsDir, dirent.name));
      versions.push({ modifiedAt: fileStat.mtime.toISOString(), version: dirent.name });
    }
    // Newest first: the version file's mtime is when that revision was recorded.
    versions.sort((a, b) =>
      a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0,
    );
    return versions;
  }

  async readVersion(path: string, version: string): Promise<Uint8Array | null> {
    const versionPath = join(`${this.#filePath(path)}${VERSIONS_SUFFIX}`, sanitizeSegment(version));
    try {
      const buffer = await readFile(versionPath);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Snapshots `bytes` into the path's version sidecar as an immutable revision.
   * The version id is content-addressed, so re-recording an identical revision
   * just rewrites the same file — harmless and idempotent.
   */
  async #recordVersion(filePath: string, version: string, bytes: Uint8Array): Promise<void> {
    const versionsDir = `${filePath}${VERSIONS_SUFFIX}`;
    await mkdir(versionsDir, { recursive: true });
    await writeFile(join(versionsDir, sanitizeSegment(version)), bytes);
  }

  #filePath(path: string): string {
    return join(this.#baseDir, sanitizePath(path));
  }

  async #collect(relativeDir: string, prefix: string, out: MemoryEntry[]): Promise<void> {
    const absoluteDir = relativeDir === "" ? this.#baseDir : join(this.#baseDir, relativeDir);
    let dirents;
    try {
      dirents = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    for (const dirent of dirents) {
      if (relativeDir === "" && dirent.name === APPLIED_KEYS_FILE) {
        continue;
      }
      // Version sidecars are infrastructure, never logical entries: a directory
      // `<name>.versions` holds the immutable revisions of the sibling file.
      if (dirent.isDirectory() && dirent.name.endsWith(VERSIONS_SUFFIX)) {
        continue;
      }
      const relativePath = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await this.#collect(relativePath, prefix, out);
        continue;
      }
      if (!dirent.isFile() || !relativePath.startsWith(prefix)) {
        continue;
      }
      const fileStat = await stat(join(this.#baseDir, relativePath));
      out.push({
        modifiedAt: fileStat.mtime.toISOString(),
        path: relativePath,
        size: fileStat.size,
      });
    }
  }

  async #readAppliedKeys(): Promise<Set<WriteKey>> {
    try {
      const raw = await readFile(join(this.#baseDir, APPLIED_KEYS_FILE), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? (parsed as WriteKey[]) : []);
    } catch (error) {
      if (isNotFound(error)) {
        return new Set();
      }
      throw error;
    }
  }

  async #writeAppliedKeys(applied: Set<WriteKey>): Promise<void> {
    await mkdir(this.#baseDir, { recursive: true });
    const ledgerPath = join(this.#baseDir, APPLIED_KEYS_FILE);
    const tempPath = `${ledgerPath}.tmp`;
    await writeFile(tempPath, JSON.stringify([...applied]));
    await rename(tempPath, ledgerPath);
  }
}

/**
 * The public backend factory for a real-filesystem-backed memory store.
 *
 * Wraps {@link FsMemoryStore} so an agent can declare a store backend without
 * touching the runtime class directly:
 *
 * ```ts
 * defineMemory({ stores: { notes: { backend: fsStore("./.eve/notes") } } });
 * ```
 *
 * The directory is the backend's identity — two stores pointing at the same
 * `dir` share their memory, regardless of what each names the mount.
 */
export function fsStore(dir: string): MemoryStore {
  return new FsMemoryStore(dir);
}

function parentOf(filePath: string): string {
  return join(filePath, "..");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
