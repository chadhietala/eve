---
"eve": minor
---

Rework the memory layer into named multi-store mounts. An agent's `memory.ts`
now declares `stores` — each a backend (`fsStore(dir)` or a custom
`MemoryStore`) mounted at a path under `/mnt/memory` with an `"ro"`/`"rw"`
access level (at most 8). The file tools route each `/mnt/memory/<store>` path
to the matching store's backend (longest-prefix wins; writes to a `ro` store are
rejected). Sharing across agents is "point at the same backend" — namespaces key
on the store name, not the agent id. Each store also keeps an off-mount
transcripts area (`transcripts/<session-id>.jsonl`) that powers per-store
consolidation. `memory.md` now compiles to orientation-only with no stores;
declaring live store backends requires `memory.ts`. The single agent-scoped
`/memory` mount, `defineMemory({ store, root })`, and the agent-scoped session
dump are removed.
