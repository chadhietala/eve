import {
  MemoryDocumentConflictError,
  type MemoryDocumentBackend,
} from "#public/memory/file/backend.js";
import { clampUnit, recordValue, type MemoryRecord } from "#public/memory/learning/record.js";

const DOCUMENT_VERSION = 1;
const MAX_CONFLICT_RETRIES = 8;

export interface LearningStoreOptions {
  readonly backend: MemoryDocumentBackend;
  /** Half-life used when scoring records for eviction. Defaults to 30 days. */
  readonly halfLifeMs?: number;
  /** Hard cap on the serialized document. Defaults to 512 KiB. */
  readonly maxBytes?: number;
  /** Hard cap on stored records. Defaults to 512. */
  readonly maxRecords?: number;
}

export interface LearningStore {
  read(input: {
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<readonly MemoryRecord[]>;
  /**
   * Applies `mutate` to the current records and conditionally replaces the
   * document, retrying on a concurrent write. Returns the records that were
   * actually stored, after eviction.
   */
  update(input: {
    readonly key: string;
    readonly mutate: (records: readonly MemoryRecord[]) => readonly MemoryRecord[];
    readonly now: number;
    readonly signal: AbortSignal;
  }): Promise<readonly MemoryRecord[]>;
}

/**
 * A bounded, versioned set of records per memory scope, stored as one
 * document.
 *
 * Reusing {@link MemoryDocumentBackend} means learning memory inherits every
 * backend file memory already has — Vercel Blob, in-memory, or an
 * application's own — instead of introducing a second storage seam. The cost
 * is a read-modify-write per capture, which is the right trade at the scale a
 * single scope's memory actually reaches.
 */
export function createLearningStore(options: LearningStoreOptions): LearningStore {
  const { backend } = options;
  const halfLifeMs = options.halfLifeMs ?? 30 * 24 * 60 * 60 * 1_000;
  const maxBytes = options.maxBytes ?? 512 * 1_024;
  const maxRecords = options.maxRecords ?? 512;

  return {
    async read({ key, signal }) {
      const document = await backend.read({ key, signal });
      return document === null ? [] : deserialize(document.content);
    },

    async update({ key, mutate, now, signal }) {
      let conflicts = 0;
      for (;;) {
        const document = await backend.read({ key, signal });
        const current = document === null ? [] : deserialize(document.content);
        const next = evict(mutate(current), now);
        const content = serialize(next);

        try {
          await backend.write({
            content,
            expectedVersion: document?.version ?? null,
            key,
            signal,
          });
          return next;
        } catch (error) {
          if (!MemoryDocumentConflictError.is(error) || conflicts >= MAX_CONFLICT_RETRIES)
            throw error;
          conflicts += 1;
        }
      }
    },
  };

  function evict(records: readonly MemoryRecord[], now: number): readonly MemoryRecord[] {
    const ranked = records.toSorted(
      (left, right) => recordValue(right, now, halfLifeMs) - recordValue(left, now, halfLifeMs),
    );
    let kept = ranked.slice(0, maxRecords);
    while (kept.length > 0 && byteLength(serialize(kept)) > maxBytes) {
      kept = kept.slice(
        0,
        Math.max(1, Math.floor(kept.length * 0.9)) - (kept.length === 1 ? 1 : 0),
      );
    }
    return kept;
  }
}

interface SerializedRecord {
  a: number;
  c: number;
  ct: number;
  i: number;
  id: string;
  k: string;
  key?: string;
  la: number;
  s?: string;
  t: string;
  tg?: readonly string[];
  u: number;
  v?: string;
  vi?: string;
}

/**
 * Keys are abbreviated and vectors are quantized to signed bytes because the
 * document is read and rewritten on every capture; the record shape is the
 * dominant cost at a few hundred records.
 */
export function serialize(records: readonly MemoryRecord[]): string {
  const serialized = records.map((record) => {
    const entry: SerializedRecord = {
      a: record.accessCount,
      c: round(record.confidence),
      ct: record.createdAt,
      i: round(record.importance),
      id: record.id,
      k: record.kind,
      la: record.lastAccessedAt,
      t: record.text,
      u: record.updatedAt,
    };
    if (record.key !== undefined) entry.key = record.key;
    if (record.source !== undefined) entry.s = record.source;
    if (record.tags !== undefined) entry.tg = record.tags;
    if (record.vector !== undefined) entry.v = quantize(record.vector);
    if (record.vectorId !== undefined) entry.vi = record.vectorId;
    return entry;
  });
  return JSON.stringify({ records: serialized, version: DOCUMENT_VERSION });
}

export function deserialize(content: string): readonly MemoryRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError("Learning memory document is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== DOCUMENT_VERSION ||
    !Array.isArray((parsed as { records?: unknown }).records)
  ) {
    throw new TypeError(
      `Learning memory document is not a version ${DOCUMENT_VERSION} record set.`,
    );
  }

  const records: MemoryRecord[] = [];
  for (const entry of (parsed as { records: readonly SerializedRecord[] }).records) {
    if (typeof entry?.id !== "string" || typeof entry.t !== "string") continue;
    const record: {
      accessCount: number;
      confidence: number;
      createdAt: number;
      id: string;
      importance: number;
      key?: string;
      kind: MemoryRecord["kind"];
      lastAccessedAt: number;
      source?: string;
      tags?: readonly string[];
      text: string;
      updatedAt: number;
      vector?: readonly number[];
      vectorId?: string;
    } = {
      accessCount: Number.isFinite(entry.a) ? entry.a : 0,
      confidence: clampUnit(entry.c),
      createdAt: entry.ct,
      id: entry.id,
      importance: clampUnit(entry.i),
      kind: entry.k as MemoryRecord["kind"],
      lastAccessedAt: entry.la,
      text: entry.t,
      updatedAt: entry.u,
    };
    if (entry.key !== undefined) record.key = entry.key;
    if (entry.s !== undefined) record.source = entry.s;
    if (entry.tg !== undefined) record.tags = entry.tg;
    if (entry.v !== undefined) record.vector = dequantize(entry.v);
    if (entry.vi !== undefined) record.vectorId = entry.vi;
    records.push(record);
  }
  return records;
}

/** Packs a unit vector into signed bytes. The error is well below retrieval's resolution. */
function quantize(vector: readonly number[]): string {
  const bytes = Buffer.allocUnsafe(vector.length);
  for (const [index, value] of vector.entries()) {
    bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(value * 127))), index);
  }
  return bytes.toString("base64");
}

function dequantize(packed: string): readonly number[] {
  const bytes = Buffer.from(packed, "base64");
  const vector = Array.from<number>({ length: bytes.length });
  for (let index = 0; index < bytes.length; index += 1) vector[index] = bytes.readInt8(index) / 127;
  return vector;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
