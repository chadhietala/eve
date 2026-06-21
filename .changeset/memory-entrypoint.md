---
"eve": patch
---

Expose the `eve/memory` entrypoint for authoring an agent's memory layer:
`defineMemory`, the `fsStore` backend, the `MemoryStore` interface for custom
backends, and the supporting types. Previously these lived only as internal
modules, so `memory.ts` could not import them from a public subpath.
