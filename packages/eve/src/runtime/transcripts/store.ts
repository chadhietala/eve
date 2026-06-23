/**
 * The eve-owned, harness-internal session transcript log.
 *
 * A transcript is the turn-by-turn record of one session — user messages,
 * assistant messages, tool calls — appended by the harness as a session runs.
 * It is the session's short-term memory and the raw material a memory dream
 * mines. It is NOT a {@link MemoryStore}: it has no mount and no
 * versioning/CAS. The only externally interesting operation is
 * {@link TranscriptStore.list} by time window — the index a dream reads — plus
 * {@link TranscriptStore.read} for the dream and {@link TranscriptStore.prune}
 * for retention.
 *
 * Transcripts are never readable by the model and never mounted under
 * `/mnt/memory`; the append side is invoked by the harness, not exposed as an
 * agent tool. Backends include {@link InMemoryTranscriptStore} (tests, dev) and
 * the filesystem/Vercel Blob backends behind this same interface.
 */

/** One recorded turn in a session transcript: an opaque JSON-serializable record. */
export type TranscriptTurn = unknown;

/**
 * Metadata about one session's transcript, as returned by a windowed listing.
 * Timestamps are epoch milliseconds so windowing and retention are plain
 * numeric comparisons.
 */
export interface TranscriptInfo {
  /** The session this transcript belongs to. */
  readonly sessionId: string;
  /** Epoch-ms of the first appended turn. */
  readonly createdAt: number;
  /** Epoch-ms of the most recent appended turn — the "touched at" used for windowing. */
  readonly updatedAt: number;
  /** Number of turns appended so far. */
  readonly turns: number;
}

/**
 * A half-open time window `[since, until)` in epoch-ms selecting transcripts by
 * when they were last touched ({@link TranscriptInfo.updatedAt}). Both bounds
 * are optional: omit `since` for "no lower bound", omit `until` for "up to now".
 */
export interface TranscriptWindow {
  /** Inclusive lower bound on `updatedAt` (epoch-ms). */
  readonly since?: number;
  /** Exclusive upper bound on `updatedAt` (epoch-ms). */
  readonly until?: number;
}

/**
 * The session transcript log. Append is harness-internal; list/read/prune serve
 * the dream and retention.
 */
export interface TranscriptStore {
  /**
   * Appends one `turn` to `sessionId`'s transcript, creating it on first write.
   * Called by the harness as a session runs; not an agent-facing operation.
   */
  append(sessionId: string, turn: TranscriptTurn): Promise<void>;

  /**
   * Lists the transcripts touched within `window`, newest first by `updatedAt`.
   * With no `window`, lists every retained transcript. A transcript matches when
   * its `updatedAt` is `>= window.since` (when given) and `< window.until` (when
   * given).
   */
  list(window?: TranscriptWindow): Promise<readonly TranscriptInfo[]>;

  /**
   * Reads every turn of `sessionId`'s transcript in append order, or `null` when
   * no such transcript exists.
   */
  read(sessionId: string): Promise<readonly TranscriptTurn[] | null>;

  /**
   * Retention: removes every transcript whose `updatedAt` is strictly older than
   * `olderThan` (epoch-ms). Returns how many transcripts were removed.
   */
  prune(olderThan: number): Promise<{ readonly removed: number }>;
}

interface StoredTranscript {
  createdAt: number;
  updatedAt: number;
  readonly turns: TranscriptTurn[];
}

/**
 * Validates that `sessionId` is a single safe identifier — non-empty and free of
 * path separators or traversal — so it can key a transcript without escaping its
 * backing store. Shared by every backend; throws on a malformed id rather than
 * silently mis-keying.
 */
export function assertSafeSessionId(sessionId: string): void {
  if (sessionId.length === 0 || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`Invalid transcript session id: "${sessionId}".`);
  }
}

/** Reports whether `updatedAt` falls within `window` (half-open `[since, until)`). */
export function withinWindow(updatedAt: number, window?: TranscriptWindow): boolean {
  if (window === undefined) {
    return true;
  }
  if (window.since !== undefined && updatedAt < window.since) {
    return false;
  }
  if (window.until !== undefined && updatedAt >= window.until) {
    return false;
  }
  return true;
}

/**
 * In-memory {@link TranscriptStore} for tests and dev.
 *
 * Holds each session's turns in a `Map` keyed by session id. The clock is
 * injectable (via `now`) so windowing and retention tests stay deterministic and
 * clock-free.
 */
export class InMemoryTranscriptStore implements TranscriptStore {
  readonly #sessions = new Map<string, StoredTranscript>();
  readonly #now: () => number;

  /**
   * @param now Injectable clock returning epoch-ms for append timestamps.
   *   Defaults to a fixed epoch so tests are deterministic unless they opt into
   *   a clock.
   */
  constructor(now: () => number = () => 0) {
    this.#now = now;
  }

  async append(sessionId: string, turn: TranscriptTurn): Promise<void> {
    assertSafeSessionId(sessionId);
    const at = this.#now();
    const existing = this.#sessions.get(sessionId);
    if (existing === undefined) {
      this.#sessions.set(sessionId, { createdAt: at, updatedAt: at, turns: [turn] });
      return;
    }
    existing.turns.push(turn);
    existing.updatedAt = at;
  }

  async list(window?: TranscriptWindow): Promise<readonly TranscriptInfo[]> {
    const infos: TranscriptInfo[] = [];
    for (const [sessionId, stored] of this.#sessions) {
      if (!withinWindow(stored.updatedAt, window)) {
        continue;
      }
      infos.push({
        sessionId,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        turns: stored.turns.length,
      });
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : 1));
    return infos;
  }

  async read(sessionId: string): Promise<readonly TranscriptTurn[] | null> {
    assertSafeSessionId(sessionId);
    const stored = this.#sessions.get(sessionId);
    return stored === undefined ? null : [...stored.turns];
  }

  async prune(olderThan: number): Promise<{ readonly removed: number }> {
    let removed = 0;
    for (const [sessionId, stored] of this.#sessions) {
      if (stored.updatedAt < olderThan) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return { removed };
  }
}
