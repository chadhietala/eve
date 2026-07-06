/**
 * eve-owned surface for a FUSE filesystem, so the driver never imports a native
 * FUSE binding directly.
 *
 * The driver ({@link MemoryFuseFilesystem}) implements {@link FuseFilesystemOps}
 * as plain async methods; a host adapts a real binding (e.g. `fuse-native`) to
 * {@link FuseBinding} and mounts it. Keeping the binding injected keeps `eve`
 * free of a native runtime dependency and lets the driver be unit-tested with a
 * fake binding and an in-memory store.
 */

/** `st_mode` type bits — the kind of a filesystem entry. */
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;

/** The subset of POSIX errnos the driver raises (positive; the binding negates). */
export const Errno = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOTEMPTY: 39,
} as const;

/** A filesystem error carrying a POSIX errno the binding maps to a `-errno` return. */
export class FuseError extends Error {
  readonly errno: number;
  constructor(errno: number, message?: string) {
    super(message ?? `fuse error ${errno}`);
    this.name = "FuseError";
    this.errno = errno;
  }
}

/** Attributes returned by {@link FuseFilesystemOps.getattr} (a `stat` result). */
export interface FuseAttr {
  /** `st_mode`: type bits ({@link S_IFREG}/{@link S_IFDIR}) OR'd with permission bits. */
  readonly mode: number;
  /** File size in bytes (0 for directories). */
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly atimeMs: number;
  readonly uid: number;
  readonly gid: number;
  /** Hard-link count — 1 for files, 2 for directories (the conventional minimum). */
  readonly nlink: number;
}

/** Filesystem-level stats returned by {@link FuseFilesystemOps.statfs}. */
export interface FuseStatfs {
  readonly bsize: number;
  readonly frsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
  readonly files: number;
  readonly ffree: number;
  readonly namemax: number;
}

/**
 * The filesystem operations a FUSE binding drives. Paths are absolute from the
 * mount root (e.g. `/notes/facts.md`; `/` is the root). Methods reject with a
 * {@link FuseError} carrying a POSIX errno; the binding turns that into the
 * kernel's `-errno` convention.
 */
export interface FuseFilesystemOps {
  getattr(path: string): Promise<FuseAttr>;
  readdir(path: string): Promise<readonly string[]>;
  open(path: string, flags: number): Promise<number>;
  create(path: string, mode: number): Promise<number>;
  read(
    path: string,
    fd: number,
    buffer: Uint8Array,
    length: number,
    position: number,
  ): Promise<number>;
  write(
    path: string,
    fd: number,
    buffer: Uint8Array,
    length: number,
    position: number,
  ): Promise<number>;
  truncate(path: string, size: number): Promise<void>;
  ftruncate(path: string, fd: number, size: number): Promise<void>;
  flush(path: string, fd: number): Promise<void>;
  release(path: string, fd: number): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  rmdir(path: string): Promise<void>;
  statfs(path: string): Promise<FuseStatfs>;
}

/** A live mount; call {@link FuseMount.unmount} to tear it down. */
export interface FuseMount {
  unmount(): Promise<void>;
}

/**
 * A native FUSE binding, adapted to eve's op surface. A host implements this by
 * wrapping e.g. `fuse-native` (see the adapter sketch in `mount.ts`); the `eve`
 * package never imports the native module itself.
 */
export interface FuseBinding {
  mount(mountPath: string, ops: FuseFilesystemOps): Promise<FuseMount>;
}
