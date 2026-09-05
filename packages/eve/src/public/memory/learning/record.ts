/** Which memory architecture produced a record. */
export type MemoryRecordKind =
  | "episode"
  | "fact"
  | "procedure"
  | "insight"
  /** A learned operating rule, managed by the self-improvement layer. */
  | "directive";

/**
 * One durable unit of learned context.
 *
 * Records are written by an architecture, ranked by a retrieval strategy, and
 * recalled into model context. Everything the ranker needs is on the record,
 * so ranking stays a pure function of the store's contents and the clock.
 */
export interface MemoryRecord {
  /** Times the record has been recalled. Reinforces what keeps proving useful. */
  readonly accessCount: number;
  /** How strongly the record is believed, 0–1. Moves with reinforcement and contradiction. */
  readonly confidence: number;
  readonly createdAt: number;
  readonly id: string;
  /** How consequential the record is, 0–1. Set by the architecture that wrote it. */
  readonly importance: number;
  readonly kind: MemoryRecordKind;
  readonly lastAccessedAt: number;
  /**
   * Stable identity for a replaceable claim. A later record with the same key
   * supersedes the earlier one instead of accumulating beside it.
   */
  readonly key?: string;
  /** Provenance, e.g. the turn that produced the record. */
  readonly source?: string;
  /** Free-form labels an application can filter on. */
  readonly tags?: readonly string[];
  readonly text: string;
  readonly updatedAt: number;
  /** Embedding id the vector was produced with, so a changed embedding is detected. */
  readonly vectorId?: string;
  /** Quantized unit vector. Absent until the record is embedded. */
  readonly vector?: readonly number[];
}

/** Upper bound on one record's text, in UTF-16 code units. */
export const MAX_RECORD_CHARACTERS = 1_024;

export interface MemoryRecordInput {
  readonly confidence?: number;
  readonly importance?: number;
  readonly key?: string;
  readonly kind: MemoryRecordKind;
  readonly source?: string;
  readonly tags?: readonly string[];
  readonly text: string;
}

/** Normalizes an architecture's output into a storable record. */
export function createRecord(input: MemoryRecordInput, now: number, id: string): MemoryRecord {
  const text = input.text.trim().replaceAll(/\s+/g, " ");
  if (text.length === 0) throw new TypeError("A memory record cannot be empty.");

  const record: {
    accessCount: number;
    confidence: number;
    createdAt: number;
    id: string;
    importance: number;
    key?: string;
    kind: MemoryRecordKind;
    lastAccessedAt: number;
    source?: string;
    tags?: readonly string[];
    text: string;
    updatedAt: number;
  } = {
    accessCount: 0,
    confidence: clampUnit(input.confidence ?? 0.6),
    createdAt: now,
    id,
    importance: clampUnit(input.importance ?? 0.5),
    kind: input.kind,
    lastAccessedAt: now,
    text: text.slice(0, MAX_RECORD_CHARACTERS),
    updatedAt: now,
  };
  if (input.key !== undefined) record.key = input.key;
  if (input.source !== undefined) record.source = input.source;
  if (input.tags !== undefined && input.tags.length > 0) record.tags = [...input.tags];
  return record;
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * A record's standing value, used to decide what survives eviction.
 *
 * Confidence and importance carry the record's worth; access count carries
 * proven usefulness; age decays everything so a store of stale beliefs loses
 * to fresh evidence without needing an explicit expiry.
 */
export function recordValue(record: MemoryRecord, now: number, halfLifeMs: number): number {
  const ageMs = Math.max(0, now - record.updatedAt);
  const freshness = Math.pow(0.5, ageMs / halfLifeMs);
  const usefulness = Math.log1p(record.accessCount) / Math.log(10);
  return (
    (0.4 * record.importance + 0.4 * record.confidence + 0.2 * Math.min(1, usefulness)) *
    (0.35 + 0.65 * freshness)
  );
}
