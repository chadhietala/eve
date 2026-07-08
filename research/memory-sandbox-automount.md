---
issue: TODO (needs a tracking issue)
last_updated: "2026-07-08"
status: proposed
---

# Auto-mounting memory stores into the sandbox

## Summary

Declaring a memory layer should be all the wiring there is. When an agent's
`memory.ts` names a durable backend, eve should mount that store into the
sandbox as a real filesystem at `/mnt/memory/<store>` — no host-supplied FUSE
binding, no manual mount call. This closes the gap left by deleting the
file-tool redirect: the tools now reach memory only through the sandbox
filesystem, so eve must put it there.

## Authoring API

Unchanged — the capability is implicit in the backend choice:

```ts title="agent/memory.ts"
import { defineMemory, s3MemoryStore, vercelBlobMemoryStore } from "eve/memory";

export default defineMemory({
  stores: {
    notes: { backend: vercelBlobMemoryStore() }, // → mounted at /mnt/memory/notes
    org: { backend: s3MemoryStore(client), access: "ro" }, // → /mnt/memory/org (read-only)
  },
});
```

No new author surface. The mount is a property of running the agent, not
something the author configures.

## Observable semantics

- At session boot, every declared store is a real directory under
  `/mnt/memory/<store>` in the sandbox. The file tools **and** any `bash`
  subprocess (`cat`, `ls`, `rg`, `>`) see the same bytes, because both hit the
  kernel mount.
- An `access: "ro"` store mounts read-only; a write returns a real
  `EROFS`-class error the model sees.
- Writes remain versioned and multi-writer-safe: the mount is a pass-through to
  the same `MemoryStore` / object store, so compare-and-swap and version history
  are still enforced by the backend's conditional writes.
- Mounts are torn down when the session ends. A mount that fails to come up
  fails the session with a clear error rather than silently serving an empty
  directory.

## Architecture

The mount runs **inside** the sandbox, not host-side. A remote sandbox's file
tools shell out via `sandbox.run`, so they only see a mount in the sandbox's own
kernel — a host-side node driver over the store would be invisible to them.

Each durable backend gains a capability: describe how to mount itself in a
sandbox. eve resolves the live backends at boot (as it already does to seed the
memory config) and, in the `onSession` boot step, runs each store's mount.

```
memory.ts (defineMemory + backend)
        │  resolved at boot
        ▼
  onSession boot step ──► for each store: sandbox.run(<mount plan>)
        │                                   │
        │                    ┌──────────────┴───────────────┐
        ▼                    ▼                              ▼
  /mnt/memory/<store>   S3 → mountpoint-s3           Blob / custom store →
  (real kernel mount)   (bucket+prefix+creds)        eve in-sandbox mounter
                                                      (MemoryFuseFilesystem +
                                                       fuse-native, run in-box)
```

Two driver kinds, one seam:

- **S3-compatible → `mountpoint-s3`.** The mount plan installs and runs
  `mount-s3` against the same bucket/prefix the `s3MemoryStore` already holds,
  with credentials passed as scoped env. This is Vercel's documented FUSE path.
- **Vercel Blob and any custom `MemoryStore` → eve's in-sandbox mounter.** Blob
  is not S3-compatible, so there is no off-the-shelf driver. eve ships a small
  mounter that reconstructs the backend in-sandbox and serves it through the
  existing `MemoryFuseFilesystem` (already built — it exposes any `MemoryStore`
  as FUSE ops) over a real `fuse-native` binding installed in the sandbox at
  boot. This is the "custom Blob driver," and it generalizes to every backend.

### What this reuses and retires

- **Reused:** `MemoryFuseFilesystem` becomes the in-sandbox driver — its
  read-only enforcement and CAS-on-flush carry over unchanged.
- **Retired / repurposed:** the host-side `FuseBinding` / `mountMemoryStores`
  abstraction was written as if eve mounted on the host. It survives only as the
  in-sandbox mounter's entrypoint (same code, run in the sandbox), or for a
  purely local sandbox in dev.

### Invariants

- The mount never becomes a second source of truth: it is a view of the same
  backend, so all durability, versioning, and CAS live in the store.
- `ro` is enforced at the mount, matching the store's declared access.
- Credentials are scoped per store. The sandbox holds them for the mount's
  lifetime (Vercel's FUSE flow exposes them in-box), so a store must be backed
  by a restricted role/token, never a broad key.

## Testable vs. infra-gated

- **Unit-testable now:** the backend mount-plan/spec generation, and the boot
  step's command sequencing (drive a fake sandbox, assert the right install +
  mount + verify commands per store, ro flag, teardown order, failure → session
  error).
- **CI/e2e only:** the actual mount against a live sandbox and real S3/Blob
  storage, and unmount cleanup.

## Verified in a live Vercel Sandbox (2026-07-08)

The central risk — can the in-sandbox node mounter actually work — is **proven**.
Driving a real Vercel Sandbox (Amazon Linux 2023, kernel 5.10) with the
`@vercel/sandbox` SDK: `/dev/fuse` is present; `sudo dnf install -y fuse
fuse-libs fuse-devel gcc make python3` provides `libfuse.so.2` + `fusermount` +
the build toolchain; `npm install fuse-native` **builds cleanly** against it.
eve's own `mountMemoryStores` API (bundled standalone via esbuild) — driven by a
`fuse-native` `FuseBinding` — mounted two stores (one `rw`, one `ro`) at
`/mnt/memory/<store>`, and from an ordinary shell in the VM:

- `ls` / `cat` return seeded content; `echo > new.md` writes and reads back
  (write → CAS flush through the kernel); `grep -rn` matches across the mount —
  i.e. a plain `bash` subprocess sees memory, the exact behavior the deleted
  redirect used to special-case.
- A `readOnly` mount rejects `echo >` with `Read-only file system` (EROFS) while
  reads still succeed — `ro` enforcement holds through a real mount.

Two implementation notes for productionization: (1) `fuse-native`'s `read`/`write`
callbacks report the byte count as the **first** argument (`cb(n)`), unlike other
ops' `cb(0, value)`; (2) the mounter process must stay alive to serve the mount.

## Open questions

- One unified in-sandbox node mounter for all backends (simpler, one code path —
  and now proven), or `mountpoint-s3` for S3 and the node mounter only for
  Blob/custom (leans on a battle-tested S3 driver)? The proven path favors the
  unified mounter.
- How is the Blob mounter packaged into the sandbox — part of the compiled
  runtime artifacts eve already ships, or installed on demand?
- Teardown guarantees: is an unmount on session end sufficient, or is a reaper
  needed for crashed sessions holding a mount?
