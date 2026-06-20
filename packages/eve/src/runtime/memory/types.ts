/**
 * Core types for the eve memory layer.
 *
 * Memory is presented as a POSIX-like filesystem but backed by an eve-owned
 * durable store. Storage is partitioned into namespaces — one per identity
 * dimension that already flows through a turn — so the four memory layers
 * (working, episodic, long-term, swarm) are namespaces over one store rather
 * than four separate storage systems. See RFC 0001.
 */

/**
 * A storage namespace: the partition a memory read/write resolves against.
 *
 * `scopeType` selects the layer; `scopeId` is the layer-specific partition
 * key (the channel continuation token for working memory, the principal key
 * for episodic, the agent node id for long-term, an org/deployment id for
 * swarm). `agentId` scopes every namespace to the resolved agent so two
 * agents never share a partition.
 */
export interface MemoryNamespace {
  readonly scopeType: "working" | "episodic" | "long-term" | "swarm";
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
 * An opaque, deterministic idempotency key for a single write.
 *
 * Derived from the namespace, the deterministic in-turn `(turnId, seq)`
 * coordinates, and the content hash so that a workflow replay re-issuing the
 * same logical write produces the same key — letting the store treat the
 * repeat as a no-op (PUT semantics). Build with `buildWriteKey`; never
 * construct one from a clock or randomness.
 */
export type WriteKey = string;
