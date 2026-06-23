import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSafeSessionId,
  type TranscriptInfo,
  type TranscriptStore,
  type TranscriptTurn,
  type TranscriptWindow,
  withinWindow,
} from "#runtime/transcripts/store.js";

const DEFAULT_BASE_DIR = ".eve/transcripts";
const TRANSCRIPT_SUFFIX = ".jsonl";

/** One serialized line in a transcript file: the append timestamp plus the turn. */
interface TranscriptLine {
  /** Epoch-ms the turn was appended. */
  readonly t: number;
  /** The turn record. */
  readonly v: TranscriptTurn;
}

/**
 * A durable {@link TranscriptStore} backed by the real filesystem.
 *
 * Each session maps to one append-only file `<baseDir>/<sessionId>.jsonl`, one
 * JSON object per line (`{ t, v }` — the append time and the turn). Timestamps
 * are embedded per line so `createdAt`/`updatedAt` are recovered from the first
 * and last lines without a sidecar or relying on filesystem mtimes; retention is
 * a file delete. The clock is injectable so windowing/retention stay testable.
 */
export class FsTranscriptStore implements TranscriptStore {
  readonly #baseDir: string;
  readonly #now: () => number;

  /**
   * @param baseDir Root directory for transcript files. Defaults to
   *   `.eve/transcripts`.
   * @param now Injectable clock returning epoch-ms for append timestamps.
   */
  constructor(baseDir: string = DEFAULT_BASE_DIR, now: () => number = () => Date.now()) {
    this.#baseDir = baseDir;
    this.#now = now;
  }

  async append(sessionId: string, turn: TranscriptTurn): Promise<void> {
    assertSafeSessionId(sessionId);
    await mkdir(this.#baseDir, { recursive: true });
    const line: TranscriptLine = { t: this.#now(), v: turn };
    await appendFile(this.#filePath(sessionId), `${JSON.stringify(line)}\n`, "utf8");
  }

  async list(window?: TranscriptWindow): Promise<readonly TranscriptInfo[]> {
    const infos: TranscriptInfo[] = [];
    for (const sessionId of await this.#sessionIds()) {
      const info = await this.#info(sessionId);
      if (info === null || !withinWindow(info.updatedAt, window)) {
        continue;
      }
      infos.push(info);
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : 1));
    return infos;
  }

  async read(sessionId: string): Promise<readonly TranscriptTurn[] | null> {
    assertSafeSessionId(sessionId);
    const lines = await this.#readLines(sessionId);
    return lines === null ? null : lines.map((line) => line.v);
  }

  async prune(olderThan: number): Promise<{ readonly removed: number }> {
    let removed = 0;
    for (const sessionId of await this.#sessionIds()) {
      const info = await this.#info(sessionId);
      if (info !== null && info.updatedAt < olderThan) {
        await rm(this.#filePath(sessionId), { force: true });
        removed += 1;
      }
    }
    return { removed };
  }

  #filePath(sessionId: string): string {
    return join(this.#baseDir, `${sessionId}${TRANSCRIPT_SUFFIX}`);
  }

  async #sessionIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.#baseDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return names
      .filter((name) => name.endsWith(TRANSCRIPT_SUFFIX))
      .map((name) => name.slice(0, name.length - TRANSCRIPT_SUFFIX.length))
      .filter((id) => id.length > 0);
  }

  async #info(sessionId: string): Promise<TranscriptInfo | null> {
    const lines = await this.#readLines(sessionId);
    if (lines === null) {
      return null;
    }
    const first = lines[0];
    const last = lines.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    return {
      sessionId,
      createdAt: first.t,
      updatedAt: last.t,
      turns: lines.length,
    };
  }

  async #readLines(sessionId: string): Promise<TranscriptLine[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const lines: TranscriptLine[] = [];
    for (const text of raw.split("\n")) {
      if (text.length === 0) {
        continue;
      }
      lines.push(JSON.parse(text) as TranscriptLine);
    }
    return lines;
  }
}

/** Re-exported so callers can probe whether a base dir exists without reaching into node:fs. */
export async function transcriptsDirExists(baseDir: string): Promise<boolean> {
  try {
    return (await stat(baseDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Factory for a filesystem-backed {@link TranscriptStore} rooted at `dir`. The
 * dev/local default; production uses a durable backend (e.g. Vercel Blob).
 *
 * ```ts
 * defineMemory({ stores: { … }, transcripts: { backend: fsTranscriptStore("./.eve/transcripts") } });
 * ```
 */
export function fsTranscriptStore(dir: string): TranscriptStore {
  return new FsTranscriptStore(dir);
}
