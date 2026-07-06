import { MemoryConflictError, type MemoryStore } from "#runtime/memory/store.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";
import {
  Errno,
  type FuseAttr,
  type FuseFilesystemOps,
  type FuseStatfs,
  FuseError,
  S_IFDIR,
  S_IFREG,
} from "#runtime/memory/fuse/types.js";

/** Bounded retries for the compare-and-swap on a whole-file flush. */
const MAX_CAS_ATTEMPTS = 5;

/** One open file handle: the whole-file buffer plus whether it needs flushing. */
interface OpenFile {
  readonly path: string;
  buf: Uint8Array;
  dirty: boolean;
}

/** Options for {@link MemoryFuseFilesystem}. */
export interface MemoryFuseFilesystemOptions {
  /** Injectable wall clock (epoch-ms) for the attributes of in-flight files. */
  readonly now?: () => number;
  /** Owner uid reported by `getattr`; defaults to the current process uid. */
  readonly uid?: number;
  /** Owner gid reported by `getattr`; defaults to the current process gid. */
  readonly gid?: number;
}

/**
 * Exposes a {@link MemoryStore} as a POSIX filesystem, so a mounted sandbox sees
 * durable memory as real files: `stat`, `ls`, `cat`, and `>` all work through
 * the kernel, not just eve's file tools.
 *
 * The store is a flat, path-keyed object store with per-write versioning and
 * compare-and-swap; this driver layers filesystem semantics on top:
 *
 * - **Directories are implicit.** A key `a/b/c.md` makes `a` and `a/b` exist;
 *   there is no directory object. `mkdir` of an *empty* directory is tracked in
 *   memory for the session (so `mkdir d && ls d` works) and materializes durably
 *   only once it holds a file — agent memory writes files, not empty trees.
 * - **Writes are whole-file.** `write` buffers into the open handle; the buffer
 *   is flushed to the store as one {@link MemoryStore.write} on `flush`/`release`.
 * - **Multi-writer is the store's CAS.** Each flush reads the current head
 *   version and writes under it as a precondition, retrying on conflict. Two
 *   sandboxes writing the same file resolve to last-writer-wins with the loser
 *   preserved in the version trail — no lost data. Concurrent writers to
 *   *different* files never conflict.
 *
 * Advisory locks (`fcntl`/`flock`) are intentionally not implemented: they can't
 * be honored across sandboxes without a distributed lock manager, and agent
 * memory does not need them.
 */
export class MemoryFuseFilesystem implements FuseFilesystemOps {
  readonly #store: MemoryStore;
  readonly #now: () => number;
  readonly #uid: number;
  readonly #gid: number;
  readonly #open = new Map<number, OpenFile>();
  readonly #pendingDirs = new Set<string>();
  #nextFd = 3;

  constructor(store: MemoryStore, options: MemoryFuseFilesystemOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
    this.#uid = options.uid ?? process.getuid?.() ?? 0;
    this.#gid = options.gid ?? process.getgid?.() ?? 0;
  }

  async getattr(path: string): Promise<FuseAttr> {
    const key = toKey(path);
    // A file open with unflushed writes reflects its buffer size, not the store's.
    const open = this.#openFile(key);
    if (open !== undefined) {
      return this.#fileAttr(open.buf.length, this.#now());
    }
    const stat = await this.#stat(key);
    if (stat === null) {
      throw new FuseError(Errno.ENOENT);
    }
    return stat.kind === "dir" ? this.#dirAttr() : this.#fileAttr(stat.size, stat.mtimeMs);
  }

  async readdir(path: string): Promise<readonly string[]> {
    const key = toKey(path);
    if (key !== "" && (await this.#stat(key))?.kind !== "dir") {
      throw new FuseError(key === "" ? Errno.EIO : Errno.ENOENT);
    }
    const prefix = key === "" ? "" : `${key}/`;
    const names = new Set<string>();
    for (const entry of await this.#store.list(prefix)) {
      const child = entry.path.slice(prefix.length).split("/")[0];
      if (child !== undefined && child.length > 0) {
        names.add(child);
      }
    }
    for (const dir of this.#pendingDirs) {
      if (dir.startsWith(prefix) && dir.length > prefix.length) {
        const child = dir.slice(prefix.length).split("/")[0];
        if (child !== undefined && child.length > 0) {
          names.add(child);
        }
      }
    }
    return [".", "..", ...names];
  }

  async open(path: string, _flags: number): Promise<number> {
    const key = toKey(path);
    const bytes = await this.#store.read(key);
    if (bytes === null) {
      throw new FuseError(Errno.ENOENT);
    }
    return this.#track({ path: key, buf: bytes, dirty: false });
  }

  async create(path: string, _mode: number): Promise<number> {
    const key = toKey(path);
    // A brand-new file is empty and dirty so an immediate `release` persists it
    // (e.g. `touch` writes zero bytes).
    return this.#track({ path: key, buf: new Uint8Array(0), dirty: true });
  }

  async read(
    _path: string,
    fd: number,
    buffer: Uint8Array,
    length: number,
    position: number,
  ): Promise<number> {
    const file = this.#require(fd);
    const slice = file.buf.subarray(position, Math.min(position + length, file.buf.length));
    buffer.set(slice, 0);
    return slice.length;
  }

  async write(
    _path: string,
    fd: number,
    buffer: Uint8Array,
    length: number,
    position: number,
  ): Promise<number> {
    const file = this.#require(fd);
    const end = position + length;
    if (end > file.buf.length) {
      const grown = new Uint8Array(end);
      grown.set(file.buf, 0);
      file.buf = grown;
    }
    file.buf.set(buffer.subarray(0, length), position);
    file.dirty = true;
    return length;
  }

  async truncate(path: string, size: number): Promise<void> {
    const key = toKey(path);
    const current = (await this.#store.read(key)) ?? new Uint8Array(0);
    await this.#casWrite(key, resize(current, size));
  }

  async ftruncate(_path: string, fd: number, size: number): Promise<void> {
    const file = this.#require(fd);
    file.buf = resize(file.buf, size);
    file.dirty = true;
  }

  async flush(_path: string, fd: number): Promise<void> {
    const file = this.#open.get(fd);
    if (file !== undefined && file.dirty) {
      await this.#casWrite(file.path, file.buf);
      file.dirty = false;
    }
  }

  async release(_path: string, fd: number): Promise<void> {
    const file = this.#open.get(fd);
    this.#open.delete(fd);
    if (file !== undefined && file.dirty) {
      await this.#casWrite(file.path, file.buf);
    }
  }

  async unlink(path: string): Promise<void> {
    const key = toKey(path);
    await this.#store.remove(
      key,
      buildWriteKey({ turnId: `fuse:unlink:${key}`, seq: 0, content: key }),
    );
  }

  async rename(src: string, dest: string): Promise<void> {
    // The store has no native rename; copy then remove. Not atomic across the two
    // ops, but agent memory does not rely on rename atomicity.
    const from = toKey(src);
    const to = toKey(dest);
    const bytes = await this.#store.read(from);
    if (bytes === null) {
      throw new FuseError(Errno.ENOENT);
    }
    await this.#casWrite(to, bytes);
    await this.#store.remove(
      from,
      buildWriteKey({ turnId: `fuse:rename:${from}`, seq: 0, content: to }),
    );
  }

  async mkdir(path: string, _mode: number): Promise<void> {
    const key = toKey(path);
    if ((await this.#stat(key)) !== null) {
      throw new FuseError(Errno.EEXIST);
    }
    this.#pendingDirs.add(key);
  }

  async rmdir(path: string): Promise<void> {
    const key = toKey(path);
    if ((await this.#store.list(`${key}/`)).length > 0) {
      throw new FuseError(Errno.ENOTEMPTY);
    }
    this.#pendingDirs.delete(key);
  }

  async statfs(_path: string): Promise<FuseStatfs> {
    // A store is not a fixed-size disk; report large free space so tools never
    // believe the "device" is full.
    const blocks = 1 << 30;
    return {
      bsize: 4096,
      frsize: 4096,
      blocks,
      bfree: blocks,
      bavail: blocks,
      files: 1 << 20,
      ffree: 1 << 20,
      namemax: 255,
    };
  }

  /**
   * Flushes `bytes` to `key` as one whole-file write, guarded by the store's
   * compare-and-swap: read the head version, write under it as the precondition,
   * and retry on conflict. This is the multi-writer safety point — the last
   * writer wins the head while every superseded revision survives in the version
   * trail. Exhausting retries surfaces `EIO` rather than risking a lost write.
   */
  async #casWrite(key: string, bytes: Uint8Array): Promise<void> {
    const writeKey = buildWriteKey({ turnId: `fuse:${key}`, seq: 0, content: bytes });
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const expected = await this.#store.head(key);
      try {
        await this.#store.write(key, bytes, writeKey, { expectedVersion: expected });
        return;
      } catch (error) {
        if (!(error instanceof MemoryConflictError) || attempt === MAX_CAS_ATTEMPTS) {
          throw new FuseError(Errno.EIO, error instanceof Error ? error.message : undefined);
        }
      }
    }
  }

  /**
   * Resolves `key` to a file (with size/mtime), a directory, or `null` (absent).
   * A directory exists when some key is a path-child of it, or it was just
   * `mkdir`ed this session. Uses a single prefix `list` and exact-matches the
   * key so a sibling like `notesbook.md` is never mistaken for a child of `notes`.
   */
  async #stat(
    key: string,
  ): Promise<{ kind: "file"; size: number; mtimeMs: number } | { kind: "dir" } | null> {
    if (key === "") {
      return { kind: "dir" };
    }
    const entries = await this.#store.list(key);
    const exact = entries.find((entry) => entry.path === key);
    if (exact !== undefined) {
      return { kind: "file", size: exact.size, mtimeMs: Date.parse(exact.modifiedAt) || 0 };
    }
    if (this.#pendingDirs.has(key) || entries.some((entry) => entry.path.startsWith(`${key}/`))) {
      return { kind: "dir" };
    }
    return null;
  }

  #openFile(key: string): OpenFile | undefined {
    for (const file of this.#open.values()) {
      if (file.path === key) {
        return file;
      }
    }
    return undefined;
  }

  #track(file: OpenFile): number {
    const fd = this.#nextFd++;
    this.#open.set(fd, file);
    return fd;
  }

  #require(fd: number): OpenFile {
    const file = this.#open.get(fd);
    if (file === undefined) {
      throw new FuseError(Errno.EBADF);
    }
    return file;
  }

  #fileAttr(size: number, mtimeMs: number): FuseAttr {
    return {
      mode: S_IFREG | 0o644,
      size,
      mtimeMs,
      ctimeMs: mtimeMs,
      atimeMs: mtimeMs,
      uid: this.#uid,
      gid: this.#gid,
      nlink: 1,
    };
  }

  #dirAttr(): FuseAttr {
    const now = this.#now();
    return {
      mode: S_IFDIR | 0o755,
      size: 0,
      mtimeMs: now,
      ctimeMs: now,
      atimeMs: now,
      uid: this.#uid,
      gid: this.#gid,
      nlink: 2,
    };
  }
}

/** Maps an absolute FUSE path (`/a/b`) to a store key (`a/b`); root → `""`. */
function toKey(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Returns `bytes` grown (zero-padded) or shrunk to exactly `size` bytes. */
function resize(bytes: Uint8Array, size: number): Uint8Array {
  if (size === bytes.length) {
    return bytes;
  }
  const next = new Uint8Array(size);
  next.set(bytes.subarray(0, Math.min(size, bytes.length)), 0);
  return next;
}
