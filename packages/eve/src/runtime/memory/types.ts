/**
 * Core types for the eve memory layer.
 *
 * Memory is presented as a POSIX-like filesystem but backed by an eve-owned
 * durable store. An agent declares named STORES, each a backend mounted at a
 * path under `/mnt/memory` — the area the agent reads and writes. A store's
 * backend instance is its identity: two agents share a store by pointing at the
 * same backend, never by agreeing on a name. Raw session transcripts are not a
 * store; they live in the separate, session-level transcript log.
 */

/**
 * Metadata for one stored memory entry, as returned by a directory listing.
 *
 * `path` is the store-relative path; `size` is the byte length of the latest
 * version; `modifiedAt` is an ISO-8601 timestamp of the latest write.
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
 * Derived from the deterministic in-turn `(turnId, seq)` coordinates and the
 * content hash so that a workflow replay re-issuing the same logical write
 * produces the same key — letting the store treat the repeat as a no-op (PUT
 * semantics). Build with `buildWriteKey`; never construct one from a clock or
 * randomness.
 */
export type WriteKey = string;
