/**
 * File-tool → memory redirect.
 *
 * When an agent declares a memory layer, the framework file tools
 * (`read_file`, `write_file`, `grep`, `glob`) transparently route paths under
 * the configured memory root to the matching {@link MountedStore}'s backend
 * instead of the sandbox. The model sees one filesystem; eve splits it at the
 * root boundary and again at each store's mount.
 *
 * A `/mnt/memory/...` path resolves to the store whose `mountPath` is the
 * longest matching prefix, then to that store's CURATED namespace and the
 * remaining sub-path. A path under the root that matches no store is "not
 * found". A write to a `ro` store throws an error the model sees. The
 * transcripts namespace is never reachable here — it is off-mount.
 *
 * All entry points are no-ops (or `false`) when no {@link MemoryConfig} is
 * present in context, so non-memory agents are completely unaffected.
 */

import { loadContext } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { resolveStoreNamespace } from "#runtime/memory/namespace.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

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
 * True iff a {@link MemoryConfig} is present in context AND `normalizedPath`
 * targets the memory mount — exactly the root, or a path beneath `<root>/`.
 *
 * Returns `false` when no memory layer is configured, leaving the sandbox path
 * untouched for non-memory agents. Whether the path actually resolves to a
 * mounted store is decided per operation; an unmatched path under the root is a
 * memory "not found" rather than a sandbox path.
 */
export function shouldRedirectToMemory(normalizedPath: string): boolean {
  const config = getMemoryConfig();
  if (config === undefined) {
    return false;
  }
  return normalizedPath === config.root || normalizedPath.startsWith(`${config.root}/`);
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

  const ns = resolveStoreNamespace(target.store.name);
  const bytes = await target.store.backend.read(ns, target.relPath);
  return bytes === null ? null : decoder.decode(bytes);
}

/**
 * Writes `content` to a memory path in place, routed to the matching store's
 * curated namespace. Throws when the path matches no mounted store, or when the
 * matched store is `ro` (read-only) — a clear error the model sees.
 *
 * The idempotency key is content-addressed via `seq: 0` (partitioned by turn id
 * when available), so a replayed identical write collapses to one.
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

  const ns = resolveStoreNamespace(target.store.name);
  const bytes = encoder.encode(content);
  const turnId = loadContext().get(SessionKey)?.turn.id ?? "";
  const writeKey = buildWriteKey({ namespace: ns, turnId, seq: 0, content });
  await target.store.backend.write(ns, target.relPath, bytes, writeKey);
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

  const ns = resolveStoreNamespace(target.store.name);
  const entries = await target.store.backend.list(ns, target.relPath);
  return entries.map((entry) => `${target.store.mountPath}/${entry.path}`);
}

/**
 * Searches memory contents under `prefix` for `pattern`, returning matches with
 * full (mount-prefixed) paths and 1-based line numbers from the matching store.
 * Returns `[]` when the prefix matches no store. `literal` matches the `grep`
 * tool's fixed-string mode by escaping regex metacharacters.
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

  const ns = resolveStoreNamespace(target.store.name);
  const source = args.literal ? escapeRegExp(args.pattern) : args.pattern;
  const flags = args.ignoreCase ? "i" : "";
  const regex = new RegExp(source, flags);

  const entries = await target.store.backend.list(ns, target.relPath);
  const hits: MemoryGrepHit[] = [];

  for (const entry of entries) {
    const bytes = await target.store.backend.read(ns, entry.path);
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
 * fixed-string (`literal`) semantics of the `grep` tool.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
