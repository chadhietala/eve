import { describe, expect, it } from "vitest";

import type { MountedStore } from "#runtime/memory/keys.js";
import { mountMemoryStores } from "#runtime/memory/fuse/mount-stores.js";
import type { FuseBinding, FuseFilesystemOps } from "#runtime/memory/fuse/types.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

const EROFS = 30;

interface Recorded {
  mountPath: string;
  ops: FuseFilesystemOps;
  unmounted: boolean;
}

/** A fake binding recording each mount and whether it was later unmounted. */
function fakeBinding(): { binding: FuseBinding; mounts: Recorded[] } {
  const mounts: Recorded[] = [];
  return {
    mounts,
    binding: {
      async mount(mountPath, ops) {
        const rec: Recorded = { mountPath, ops, unmounted: false };
        mounts.push(rec);
        return {
          async unmount() {
            rec.unmounted = true;
          },
        };
      },
    },
  };
}

function store(name: string, mountPath: string, access: "ro" | "rw"): MountedStore {
  return { name, backend: new InMemoryMemoryStore(), mountPath, access };
}

describe("mountMemoryStores", () => {
  it("mounts every store at its own path", async () => {
    const { binding, mounts } = fakeBinding();
    await mountMemoryStores({
      binding,
      stores: [store("notes", "/mnt/memory/notes", "rw"), store("org", "/mnt/memory/org", "ro")],
    });
    expect(mounts.map((m) => m.mountPath)).toEqual(["/mnt/memory/notes", "/mnt/memory/org"]);
  });

  it("mounts a ro store read-only and a rw store writable", async () => {
    const { binding, mounts } = fakeBinding();
    await mountMemoryStores({
      binding,
      stores: [store("notes", "/mnt/memory/notes", "rw"), store("org", "/mnt/memory/org", "ro")],
    });
    const [rw, ro] = mounts;
    // The rw mount accepts a create; the ro mount rejects it with EROFS.
    await expect(rw!.ops.create("/x.md", 0o644)).resolves.toBeTypeOf("number");
    await expect(ro!.ops.create("/x.md", 0o644)).rejects.toMatchObject({ errno: EROFS });
  });

  it("returns one handle whose unmount tears down every mount", async () => {
    const { binding, mounts } = fakeBinding();
    const handle = await mountMemoryStores({
      binding,
      stores: [store("a", "/mnt/memory/a", "rw"), store("b", "/mnt/memory/b", "rw")],
    });
    expect(mounts.every((m) => m.unmounted)).toBe(false);
    await handle.unmount();
    expect(mounts.every((m) => m.unmounted)).toBe(true);
  });

  it("unmounts in reverse order", async () => {
    const order: string[] = [];
    const binding: FuseBinding = {
      async mount(mountPath, _ops) {
        return {
          async unmount() {
            order.push(mountPath);
          },
        };
      },
    };
    const handle = await mountMemoryStores({
      binding,
      stores: [
        store("a", "/mnt/memory/a", "rw"),
        store("b", "/mnt/memory/b", "rw"),
        store("c", "/mnt/memory/c", "rw"),
      ],
    });
    await handle.unmount();
    expect(order).toEqual(["/mnt/memory/c", "/mnt/memory/b", "/mnt/memory/a"]);
  });

  it("tears down already-mounted stores when a later mount fails", async () => {
    let unmounted = 0;
    let calls = 0;
    const binding: FuseBinding = {
      async mount(_mountPath, _ops) {
        calls += 1;
        if (calls === 2) {
          throw new Error("mount 2 failed");
        }
        return {
          async unmount() {
            unmounted += 1;
          },
        };
      },
    };
    await expect(
      mountMemoryStores({
        binding,
        stores: [
          store("a", "/mnt/memory/a", "rw"),
          store("b", "/mnt/memory/b", "rw"),
          store("c", "/mnt/memory/c", "rw"),
        ],
      }),
    ).rejects.toThrow("mount 2 failed");
    // The one store that came up (a) is torn back down; c is never attempted.
    expect(unmounted).toBe(1);
    expect(calls).toBe(2);
  });

  it("keeps unmounting the rest when one unmount throws, then aggregates the error", async () => {
    const binding: FuseBinding = {
      async mount(mountPath, _ops) {
        return {
          async unmount() {
            if (mountPath === "/mnt/memory/b") {
              throw new Error("b stuck");
            }
          },
        };
      },
    };
    const handle = await mountMemoryStores({
      binding,
      stores: [
        store("a", "/mnt/memory/a", "rw"),
        store("b", "/mnt/memory/b", "rw"),
        store("c", "/mnt/memory/c", "rw"),
      ],
    });
    await expect(handle.unmount()).rejects.toBeInstanceOf(AggregateError);
  });
});
