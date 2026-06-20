---
"eve": patch
---

Add a `memory` definition kind. Author a `memory.md` / `memory.{ts,...}` file
(or a `memory/` directory) at the agent root and the agent gets a durable memory
filesystem mounted at `/memory`: the file tools (`read`/`write`/`grep`/`ls`)
under that root transparently redirect to an eve-owned store (filesystem-backed
by default) that persists across turns, while `bash` is never redirected. The
`memory.md` body (or the `memory.ts` return) is orientation text injected as a
system pointer, like instructions — guidance, not a file under the mount; the
agent maintains its own files (e.g. an `index.md` table of contents). A
`memory.ts` may additionally supply its own `store` and
`onRead`/`onWrite`/`onList`/`onGrep` handlers. Memory is opt-in — agents without
it are unaffected.
