---
"eve": patch
---

Memory stores now version every write and guard against lost updates. Each
write that changes content records an immutable version (list and restore the
full history via the store's `listVersions`/`readVersion`), and concurrent
writers to a shared store no longer silently clobber each other — the file-tool
memory redirect uses transparent compare-and-swap with bounded retry, so the
last writer still wins the head but every superseded revision survives in the
version trail.
