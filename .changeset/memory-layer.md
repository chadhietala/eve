---
"eve": minor
---

Add a durable memory layer for agents. Author a `memory.ts` (or a `memory/`
directory) at the agent root and the agent gets a memory filesystem mounted
under `/mnt/memory`, exposed through the public `eve/memory` entrypoint
(`defineMemory`, the `fsStore` backend, the `MemoryStore` interface for custom
backends, and supporting types).

- **Named multi-store mounts.** `memory.ts` declares `stores` — each a backend
  (`fsStore(dir)` or a custom `MemoryStore`) mounted at a path under
  `/mnt/memory` with an `"ro"`/`"rw"` access level and an optional one-line
  `description` (at most 8 stores). The file tools (`read`/`write`/`grep`/`ls`)
  route each `/mnt/memory/<store>` path to the matching backend (longest-prefix
  wins; writes to a `ro` store are rejected); `bash` is never redirected.
  Sharing across agents is "point at the same backend" — the store name is a
  local mount alias, not the sharing key.

- **Versioned, lost-update-safe writes.** Every write that changes content
  records an immutable version (list/restore history via the store's
  `listVersions`/`readVersion`), and concurrent writers to a shared store no
  longer clobber each other — the redirect uses transparent compare-and-swap
  with bounded retry.

- **Session transcripts.** A single eve-owned, session-level append-only log
  (declare `transcripts.backend` — `fsTranscriptStore` in dev,
  `vercelBlobTranscriptStore` on Vercel, or any `TranscriptStore` — and
  `transcripts.retention` `maxAge`, pruned after a dream).

- **Declarative dreaming.** Give `dream.instructions`, a lookback
  `window`, and a `cron` cadence (defaults to daily). The framework runs the
  dream on that cron; a run whose window holds no new sessions is a cheap no-op.
  By default the dream runs as an agent over the mounted `rw` stores — it reads
  the windowed transcripts and updates memory with the file tools, steered by
  each store's `description`. A `run` override remains as an escape hatch.

Memory is opt-in and authored in TypeScript only (a markdown `memory.md` is not
a memory source); a memory layer must declare at least one store.
