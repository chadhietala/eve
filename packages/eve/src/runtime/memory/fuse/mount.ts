import type { MemoryStore } from "#runtime/memory/store.js";
import {
  MemoryFuseFilesystem,
  type MemoryFuseFilesystemOptions,
} from "#runtime/memory/fuse/filesystem.js";
import type { FuseBinding, FuseMount } from "#runtime/memory/fuse/types.js";

/** Inputs for {@link mountMemoryFilesystem}. */
export interface MountMemoryFilesystemInput extends MemoryFuseFilesystemOptions {
  /** The durable store to expose as a filesystem. */
  readonly store: MemoryStore;
  /** Absolute mount point in the sandbox, e.g. `/mnt/memory/notes`. */
  readonly mountPath: string;
  /**
   * The native FUSE binding, adapted to eve's op surface. Injected so the `eve`
   * package never depends on a native module (a host wraps e.g. `fuse-native`;
   * see the adapter sketch below).
   */
  readonly binding: FuseBinding;
}

/**
 * Mounts a {@link MemoryStore} as a POSIX filesystem at `mountPath` via the
 * injected {@link FuseBinding}. Returns the live {@link FuseMount}; call
 * `unmount()` to tear it down.
 *
 * After this resolves, ordinary shell commands in the sandbox (`stat`, `ls`,
 * `cat`, `>`) operate on durable memory, coherently with eve's file tools,
 * because both hit the same store.
 *
 * The host supplies `binding` by wrapping a native FUSE library. A `fuse-native`
 * adapter is about twenty lines — translate each callback op to the async
 * {@link import("./types.js").FuseFilesystemOps} method and map a thrown
 * {@link import("./types.js").FuseError} to `-errno`:
 *
 * ```ts
 * import Fuse from "fuse-native";
 * import type { FuseBinding } from "eve/memory-internal";
 *
 * export const fuseNativeBinding: FuseBinding = {
 *   async mount(mountPath, ops) {
 *     const wrap = (fn) => (...args) => {
 *       const cb = args.pop();
 *       fn(...args).then(
 *         (v) => cb(0, v),
 *         (e) => cb(-(e?.errno ?? 5)), // FuseError.errno, else EIO
 *       );
 *     };
 *     const fuse = new Fuse(mountPath, {
 *       getattr: wrap((p) => ops.getattr(p)),
 *       readdir: wrap((p) => ops.readdir(p)),
 *       open: wrap((p, f) => ops.open(p, f)),
 *       create: wrap((p, m) => ops.create(p, m)),
 *       read: wrap((p, fd, buf, len, pos) => ops.read(p, fd, buf, len, pos)),
 *       write: wrap((p, fd, buf, len, pos) => ops.write(p, fd, buf, len, pos)),
 *       truncate: wrap((p, s) => ops.truncate(p, s)),
 *       ftruncate: wrap((p, fd, s) => ops.ftruncate(p, fd, s)),
 *       flush: wrap((p, fd) => ops.flush(p, fd)),
 *       release: wrap((p, fd) => ops.release(p, fd)),
 *       unlink: wrap((p) => ops.unlink(p)),
 *       rename: wrap((s, d) => ops.rename(s, d)),
 *       mkdir: wrap((p, m) => ops.mkdir(p, m)),
 *       rmdir: wrap((p) => ops.rmdir(p)),
 *       statfs: wrap((p) => ops.statfs(p)),
 *     }, { force: true, mkdir: true });
 *     await new Promise<void>((res, rej) => fuse.mount((e) => (e ? rej(e) : res())));
 *     return { unmount: () => new Promise<void>((res) => fuse.unmount(() => res())) };
 *   },
 * };
 * ```
 */
export async function mountMemoryFilesystem(input: MountMemoryFilesystemInput): Promise<FuseMount> {
  const options: {
    -readonly [K in keyof MemoryFuseFilesystemOptions]: MemoryFuseFilesystemOptions[K];
  } = {};
  if (input.now !== undefined) {
    options.now = input.now;
  }
  if (input.uid !== undefined) {
    options.uid = input.uid;
  }
  if (input.gid !== undefined) {
    options.gid = input.gid;
  }
  if (input.readOnly !== undefined) {
    options.readOnly = input.readOnly;
  }
  const fs = new MemoryFuseFilesystem(input.store, options);
  return input.binding.mount(input.mountPath, fs);
}
