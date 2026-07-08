/**
 * Direct memory-store access for server-side consumers.
 *
 * The file tools reach memory as a real filesystem mounted in the sandbox, so
 * they never route through here. But the **dream** runs with no sandbox — a
 * bounded model loop over the store backends — and needs to read, write, list,
 * and grep memory directly. These helpers resolve a model-facing
 * `/mnt/memory/<store>/<file>` path to the matching {@link MountedStore} backend
 * (longest-prefix wins) and operate on it, with the same versioned,
 * compare-and-swap write semantics the mount enforces.
 *
 * Every entry point is a no-op (or empty) when no {@link MemoryConfig} is in
 * context, so a consumer without a memory layer is unaffected. A write to a `ro`
 * store throws a clear error the caller (the dream model) can react to.
 */

import { loadContext } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { MemoryConflictError } from "#runtime/memory/store.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

/**
 * How many times a write re-reads the head and retries after a compare-and-swap
 * conflict before giving up. Bounded so a pathological write-storm surfaces a
 * clear error instead of spinning forever.
 */
const MAX_CAS_ATTEMPTS = 3;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * One content-search match in memory: the full (mount-prefixed) path, the
 * 1-based line number, and the line text.
 */
export interface MemoryGrepHit {
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
}

interface MemoryGrepArgs {
  readonly prefix: string;
  readonly pattern: string;
  readonly ignoreCase: boolean;
  readonly literal: boolean;
  readonly limit: number;
}

/** A path resolved to a specific store and the store-relative sub-path. */
interface ResolvedTarget {
  readonly store: MountedStore;
  readonly relPath: string;
}

function getMemoryConfig(): MemoryConfig | undefined {
  return loadContext().get(MemoryConfigKey);
}

/**
 * True iff `mountPath` is a prefix of `path` at a path boundary — `path` is
 * either exactly `mountPath` or sits under `<mountPath>/`. Prevents
 * `/mnt/memory/notes` from matching a `/mnt/memory/notebook` mount.
 */
function isUnderMount(path: string, mountPath: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

/**
 * Resolves a model-facing absolute path to the store whose mount is its longest
 * matching prefix, plus the store-relative sub-path (`""` at the bare mount).
 * Returns `undefined` when the path matches no store.
 */
function resolveTarget(config: MemoryConfig, path: string): ResolvedTarget | undefined {
  let best: MountedStore | undefined;
  for (const store of config.stores) {
    if (!isUnderMount(path, store.mountPath)) {
      continue;
    }
    if (best === undefined || store.mountPath.length > best.mountPath.length) {
      best = store;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const relPath = path === best.mountPath ? "" : path.slice(best.mountPath.length + 1);
  return { store: best, relPath };
}

/**
 * Reads a memory path, returning its content as a string or `null` when the
 * path does not exist or matches no mounted store.
 */
export async function memoryRead(path: string): Promise<string | null> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return null;
  }

  const target = resolveTarget(config, path);
  if (target === undefined) {
    return null;
  }

  const bytes = await target.store.backend.read(target.relPath);
  return bytes === null ? null : decoder.decode(bytes);
}

/**
 * Writes `content` to a memory path in place, routed to the matching store.
 * Throws when the path matches no mounted store, or when the matched store is
 * `ro` (read-only) — a clear error the caller sees.
 *
 * The idempotency key is content-addressed via `seq: 0` (partitioned by turn id
 * when available), so a replayed identical write collapses to one.
 *
 * Writes are CONFLICT-AWARE: read the current head, derive an `expectedVersion`,
 * and write under that compare-and-swap precondition. If a concurrent writer
 * moved the head between the read and the write the store throws
 * {@link MemoryConflictError}; re-read the (now newer) head and retry, up to
 * {@link MAX_CAS_ATTEMPTS} times. The content is fixed across retries, so this
 * is conflict-aware last-write-wins: the last writer wins the head, but because
 * every write is versioned no write is ever silently lost — the clobbered
 * revision survives in the version history. Exhausting retries surfaces a clear
 * error rather than risking a lost write.
 */
export async function memoryWrite(path: string, content: string): Promise<void> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return;
  }

  const target = resolveTarget(config, path);
  if (target === undefined) {
    throw new Error(`No memory store is mounted at "${path}".`);
  }
  if (target.store.access === "ro") {
    throw new Error(
      `Memory store "${target.store.name}" mounted at "${target.store.mountPath}" is read-only; cannot write "${path}".`,
    );
  }

  const bytes = encoder.encode(content);
  const turnId = loadContext().get(SessionKey)?.turn.id ?? "";
  const writeKey = buildWriteKey({ turnId, seq: 0, content });

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const expected = await target.store.backend.head(target.relPath);
    try {
      await target.store.backend.write(target.relPath, bytes, writeKey, {
        expectedVersion: expected,
      });
      return;
    } catch (error) {
      // Only a CAS conflict is retryable — a racing writer moved the head. Any
      // other failure (e.g. an I/O error) propagates untouched.
      if (!(error instanceof MemoryConflictError) || attempt === MAX_CAS_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/**
 * Lists memory entries under `prefix`, returning full (mount-prefixed) paths
 * from the matching store. Returns `[]` when the prefix matches no store.
 */
export async function memoryList(prefix: string): Promise<string[]> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return [];
  }

  const target = resolveTarget(config, prefix);
  if (target === undefined) {
    return [];
  }

  const entries = await target.store.backend.list(target.relPath);
  return entries.map((entry) => `${target.store.mountPath}/${entry.path}`);
}

/**
 * Searches memory contents under `prefix` for `pattern`, returning matches with
 * full (mount-prefixed) paths and 1-based line numbers from the matching store.
 * Returns `[]` when the prefix matches no store. `literal` matches a
 * fixed-string mode by escaping regex metacharacters.
 */
export async function memoryGrep(args: MemoryGrepArgs): Promise<MemoryGrepHit[]> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return [];
  }

  const target = resolveTarget(config, args.prefix);
  if (target === undefined) {
    return [];
  }

  const source = args.literal ? escapeRegExp(args.pattern) : args.pattern;
  const flags = args.ignoreCase ? "i" : "";
  const regex = new RegExp(source, flags);

  const entries = await target.store.backend.list(target.relPath);
  const hits: MemoryGrepHit[] = [];

  for (const entry of entries) {
    const bytes = await target.store.backend.read(entry.path);
    if (bytes === null) {
      continue;
    }
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        hits.push({
          path: `${target.store.mountPath}/${entry.path}`,
          lineNumber: i + 1,
          line,
        });
        if (hits.length >= args.limit) {
          return hits;
        }
      }
    }
  }

  return hits;
}

/**
 * Escapes regex metacharacters so a pattern matches literally — the
 * fixed-string (`literal`) search semantics.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
