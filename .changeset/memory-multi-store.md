---
"eve": minor
---

Rework the memory layer into named multi-store mounts. An agent's `memory.ts`
now declares `stores` — each a backend (`fsStore(dir)` or a custom
`MemoryStore`) mounted at a path under `/mnt/memory` with an `"ro"`/`"rw"`
access level (at most 8). The file tools route each `/mnt/memory/<store>` path
to the matching store's backend (longest-prefix wins; writes to a `ro` store are
rejected). Sharing across agents is "point at the same backend" — the store name
is a local mount alias, not the sharing key, so namespaces are constant within a
backend (the backend instance is the identity). Each store also keeps an off-mount
transcripts area (`transcripts/<session-id>.jsonl`) that powers per-store
consolidation. Memory is authored in TypeScript only — `memory.ts` (or a
`memory/` directory of modules); a markdown `memory.md` is not a memory source
and discovery flags it with a diagnostic. A memory layer must declare at least
one store (zero stores is a compile error). The single agent-scoped `/memory`
mount, `defineMemory({ store, root })`, and the agent-scoped session dump are
removed.
