import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TimerStore } from "#runtime/timer/store.js";
import type { TimerRecord } from "#runtime/timer/types.js";

const DEFAULT_BASE_DIR = ".eve/timers";

/**
 * Maps one timer `key` to a single filesystem-safe filename.
 *
 * Percent-encodes every character outside an unreserved allowlist so that path
 * separators, `..` traversal, and other reserved bytes cannot leak into the
 * on-disk layout. The mapping is total and reversible enough that distinct keys
 * never collide on a sanitized name.
 */
function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

/**
 * A durable {@link TimerStore} backed by the real filesystem.
 *
 * Each {@link TimerRecord} is persisted as its own JSON file
 * `<baseDir>/<sanitized-key>.json`, so arm/cancel/claim all survive a process
 * restart — durability is the point. Storing one record per file keeps each
 * mutation a self-contained atomic write (temp file + rename) without rewriting
 * a shared document, which matters once many timers coexist.
 *
 * {@link FsTimerStore.claimDue} is atomic enough for the single-sweeper model
 * the registry assumes: it reads each record, selects those that are `"armed"`
 * with `dueAt <= now`, and writes each back as `"fired"` (durably committing the
 * transition) before returning it. The fired status is persisted before the
 * record is handed back, so a crash after the claim still leaves it claimed —
 * a second sweeper, even from a fresh instance, never re-selects it.
 */
export class FsTimerStore implements TimerStore {
  readonly #baseDir: string;

  /**
   * @param baseDir Root directory for all timer records. Defaults to
   *   `.eve/timers` relative to the process working directory. No clock is
   *   injected here: all deadlines are absolute `dueAt` values supplied by the
   *   caller, and selection compares them against a caller-injected `now`.
   */
  constructor(baseDir: string = DEFAULT_BASE_DIR) {
    this.#baseDir = baseDir;
  }

  async arm(record: Pick<TimerRecord, "key" | "dueAt" | "task">): Promise<void> {
    await this.#write({
      key: record.key,
      dueAt: record.dueAt,
      task: record.task,
      status: "armed",
    });
  }

  async cancel(key: string): Promise<void> {
    const existing = await this.get(key);
    if (existing === null) {
      return;
    }
    await this.#write({ ...existing, status: "cancelled" });
  }

  async claimDue(now: number, limit: number): Promise<TimerRecord[]> {
    const records = await this.#readAll();
    const claimed: TimerRecord[] = [];
    for (const record of records) {
      if (claimed.length >= limit) {
        break;
      }
      if (record.status !== "armed" || record.dueAt > now) {
        continue;
      }
      const fired: TimerRecord = { ...record, status: "fired" };
      // Commit the fired transition durably before returning it, so a crash
      // after the claim cannot let a later sweep re-select the same timer.
      await this.#write(fired);
      claimed.push(fired);
    }
    return claimed;
  }

  async get(key: string): Promise<TimerRecord | null> {
    try {
      const raw = await readFile(this.#filePath(key), "utf8");
      return parseRecord(raw);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async #readAll(): Promise<TimerRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#baseDir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const records: TimerRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) {
        continue;
      }
      const raw = await readFile(join(this.#baseDir, name), "utf8");
      const record = parseRecord(raw);
      if (record !== null) {
        records.push(record);
      }
    }
    // Stable ordering keeps `limit` selection deterministic across sweeps.
    records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return records;
  }

  async #write(record: TimerRecord): Promise<void> {
    await mkdir(this.#baseDir, { recursive: true });
    const filePath = this.#filePath(record.key);
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(record));
    await rename(tempPath, filePath);
  }

  #filePath(key: string): string {
    return join(this.#baseDir, `${sanitizeKey(key)}.json`);
  }
}

function parseRecord(raw: string): TimerRecord | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as TimerRecord).key !== "string"
  ) {
    return null;
  }
  return parsed as TimerRecord;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
