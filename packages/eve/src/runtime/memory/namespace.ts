import type { MemoryNamespace } from "#runtime/memory/types.js";

/**
 * The fixed partition for a store's curated and transcripts areas.
 *
 * A store's backend instance *is* its identity: two agents share a store by
 * pointing at the same backend, never by agreeing on a name. The local name in
 * `defineMemory({ stores })` is only a mount alias, so it must not enter the
 * namespace — if it did, the same backend under two different aliases would
 * split into two partitions and silently fail to share. We therefore partition
 * a backend solely by `scopeType` (curated vs. transcripts) using a constant
 * agent/scope id; the backend itself supplies all the tenancy that matters.
 */
const CURATED_NAMESPACE: MemoryNamespace = {
  agentId: "memory",
  scopeId: "memory",
  scopeType: "store",
};

const TRANSCRIPTS_NAMESPACE: MemoryNamespace = {
  agentId: "memory",
  scopeId: "memory",
  scopeType: "transcripts",
};

/**
 * Resolves a store's CURATED {@link MemoryNamespace} — the area mounted under
 * `/mnt/memory/<path>` and served by the file-tool redirect.
 *
 * Constant within a backend: every agent that points at a given backend resolves
 * the same curated namespace and therefore reads and writes the same memory.
 * Sharing is "point at the same backend", not "share a name" (the name is a
 * local alias). This is the massaged memory the agent reads, distinct from the
 * raw transcripts (see {@link resolveTranscriptsNamespace}).
 */
export function resolveStoreNamespace(): MemoryNamespace {
  return CURATED_NAMESPACE;
}

/**
 * Resolves a store's off-mount TRANSCRIPTS {@link MemoryNamespace} — the
 * immutable area where per-session `transcripts/<id>.jsonl` dumps land.
 *
 * Constant within a backend like {@link resolveStoreNamespace}, so every agent
 * that can write the store dumps into the same transcripts area and the store's
 * dream later sees all of them. Because it is a different `scopeType` from the
 * curated namespace, it is never reachable through the mount (the redirect
 * serves only curated namespaces) — it is infrastructure that powers
 * consolidation.
 */
export function resolveTranscriptsNamespace(): MemoryNamespace {
  return TRANSCRIPTS_NAMESPACE;
}
