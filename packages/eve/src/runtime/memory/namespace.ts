import type { MemoryNamespace } from "#runtime/memory/types.js";

/**
 * Resolves a memory store's CURATED {@link MemoryNamespace} — the area mounted
 * under `/mnt/memory/<path>` and served by the file-tool redirect.
 *
 * Keyed on the **store name**, not the agent id: two agents that mount the same
 * named backend resolve the same curated namespace and therefore read and write
 * the same memory. Sharing is "point at the same store", not "share an agent
 * id". This is the massaged memory the agent reads, distinct from the raw
 * transcripts (see {@link resolveTranscriptsNamespace}).
 */
export function resolveStoreNamespace(storeName: string): MemoryNamespace {
  return {
    agentId: storeName,
    scopeId: storeName,
    scopeType: "store",
  };
}

/**
 * Resolves a memory store's off-mount TRANSCRIPTS {@link MemoryNamespace} — the
 * immutable area where per-session `transcripts/<id>.jsonl` dumps land.
 *
 * Keyed on the **store name** like {@link resolveStoreNamespace}, so every agent
 * that can write the store dumps into the same transcripts area and the store's
 * dream later sees all of them. Because it is a different `scopeType` from the
 * curated namespace, it is never reachable through the mount (the redirect
 * serves only curated namespaces) — it is infrastructure that powers
 * consolidation.
 */
export function resolveTranscriptsNamespace(storeName: string): MemoryNamespace {
  return {
    agentId: storeName,
    scopeId: storeName,
    scopeType: "transcripts",
  };
}
