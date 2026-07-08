import type { MountedStore } from "#runtime/memory/keys.js";
import {
  mountMemoryFilesystem,
  type MountMemoryFilesystemInput,
} from "#runtime/memory/fuse/mount.js";
import type { FuseBinding, FuseMount } from "#runtime/memory/fuse/types.js";

/** Inputs for {@link mountMemoryStores}. */
export interface MountMemoryStoresInput {
  /**
   * The resolved stores to expose, each at its own `mountPath` and honoring its
   * `access` — a `ro` store mounts read-only. This is the same
   * {@link MountedStore} list the memory config resolves for a turn.
   */
  readonly stores: readonly MountedStore[];
  /**
   * The native FUSE binding, injected so the `eve` package never depends on a
   * native module. One binding drives every store's mount.
   */
  readonly binding: FuseBinding;
  /** Injectable wall clock (epoch-ms), forwarded to each mount. */
  readonly now?: () => number;
  /** Owner uid reported by `getattr`, forwarded to each mount. */
  readonly uid?: number;
  /** Owner gid reported by `getattr`, forwarded to each mount. */
  readonly gid?: number;
}

/**
 * Mounts every store in a memory config as its own POSIX filesystem, so the
 * sandbox sees the whole memory tree under `/mnt/memory/<store>` as real files.
 * This is the boot-time wiring a host runs once a {@link FuseBinding} is
 * available: it turns the resolved {@link MountedStore} list into live mounts,
 * mapping each store's `access` to the driver's read-only enforcement.
 *
 * Returns a single {@link FuseMount} whose `unmount()` tears down every store's
 * mount (in reverse order, best-effort — a failed unmount does not abandon the
 * rest). If any mount fails to come up, the ones already mounted are torn back
 * down before the error propagates, so a partial boot never leaks mounts.
 */
export async function mountMemoryStores(input: MountMemoryStoresInput): Promise<FuseMount> {
  const mounts: FuseMount[] = [];
  try {
    for (const store of input.stores) {
      const mountInput: {
        -readonly [K in keyof MountMemoryFilesystemInput]: MountMemoryFilesystemInput[K];
      } = {
        store: store.backend,
        mountPath: store.mountPath,
        binding: input.binding,
        readOnly: store.access === "ro",
      };
      if (input.now !== undefined) {
        mountInput.now = input.now;
      }
      if (input.uid !== undefined) {
        mountInput.uid = input.uid;
      }
      if (input.gid !== undefined) {
        mountInput.gid = input.gid;
      }
      mounts.push(await mountMemoryFilesystem(mountInput));
    }
  } catch (error) {
    await unmountAll(mounts);
    throw error;
  }
  return { unmount: () => unmountAll(mounts) };
}

/** Unmounts every mount in reverse, collecting failures so one bad unmount does
 * not strand the others. Throws an {@link AggregateError} if any failed. */
async function unmountAll(mounts: readonly FuseMount[]): Promise<void> {
  const errors: unknown[] = [];
  for (const mount of [...mounts].reverse()) {
    try {
      await mount.unmount();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to unmount one or more memory stores");
  }
}
