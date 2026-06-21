/**
 * Core types for the eve memory layer.
 *
 * Memory is presented as a POSIX-like filesystem but backed by an eve-owned
 * durable store. An agent declares named STORES, each a backend mounted at a
 * path under `/mnt/memory`. Each store partitions into two namespaces over its
 * backend — a CURATED area (mounted, what the agent reads/writes) and a
 * TRANSCRIPTS area (off-mount, the raw record that powers consolidation) — so a
 * store is two namespaces over one backend rather than two storage systems.
 */

/**
 * A storage namespace: the partition a memory read/write resolves against.
 *
 * `scopeType` selects the area: `"store"` is the curated, mounted area an agent
 * reads and writes; `"transcripts"` is the off-mount, immutable area holding the
 * raw per-session transcript dumps — the source material a consolidation reads,
 * never served through the mount. Both are keyed by the **store name**:
 * `scopeId` and `agentId` both carry it, so two agents pointing at the same
 * named backend resolve the same partition (sharing keys on the store, not the
 * agent id).
 */
export interface MemoryNamespace {
  readonly scopeType: "store" | "transcripts";
  readonly scopeId: string;
  readonly agentId: string;
}

/**
 * Metadata for one stored memory entry, as returned by a directory listing.
 *
 * `path` is the logical (namespace-relative) path; `size` is the byte length
 * of the latest version; `modifiedAt` is an ISO-8601 timestamp of the latest
 * write.
 */
export interface MemoryEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

/**
 * One immutable, historical version of a stored path.
 *
 * `version` is the content-address of that revision — `sha256(content)` hex,
 * the same digest used as the compare-and-swap precondition. `modifiedAt` is
 * the ISO-8601 timestamp the version was recorded. Versions are listed
 * newest-first; "restore" is read an old version's bytes and write them back
 * (which records a fresh version equal to the old content).
 */
export interface MemoryVersion {
  readonly version: string;
  readonly modifiedAt: string;
}

/**
 * An opaque, deterministic idempotency key for a single write.
 *
 * Derived from the namespace, the deterministic in-turn `(turnId, seq)`
 * coordinates, and the content hash so that a workflow replay re-issuing the
 * same logical write produces the same key — letting the store treat the
 * repeat as a no-op (PUT semantics). Build with `buildWriteKey`; never
 * construct one from a clock or randomness.
 */
export type WriteKey = string;
