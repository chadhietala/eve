/**
 * File-tool → memory redirect.
 *
 * When an agent declares a memory layer, the framework file tools
 * (`read_file`, `write_file`, `grep`, `glob`) transparently route paths under
 * the configured memory root to the {@link MemoryStore} instead of the
 * sandbox. The model sees one filesystem; eve splits it at the root boundary.
 *
 * All entry points are no-ops (or `false`) when no {@link MemoryConfig} is
 * present in context, so non-memory agents are completely unaffected.
 */

import { loadContext } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * One content-search match in memory: the full (root-prefixed) path, the
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

function getMemoryConfig(): MemoryConfig | undefined {
  return loadContext().get(MemoryConfigKey);
}

/**
 * Resolves a model-facing absolute path to a namespace-relative memory path.
 *
 * The path is assumed to already satisfy {@link shouldRedirectToMemory}, so it
 * is either exactly the root (→ `""`) or sits under `<root>/`.
 */
function toRelativePath(config: MemoryConfig, path: string): string {
  if (path === config.root) {
    return "";
  }
  return path.slice(config.root.length + 1);
}

/**
 * Resolves a model-facing absolute prefix to a namespace-relative prefix,
 * tolerating a bare root (no trailing slash) by mapping it to the empty
 * prefix (list everything in the namespace).
 */
function toRelativePrefix(config: MemoryConfig, prefix: string): string {
  if (prefix === config.root) {
    return "";
  }
  return prefix.slice(config.root.length + 1);
}

/**
 * True iff a {@link MemoryConfig} is present in context AND `normalizedPath`
 * targets the memory mount — exactly the root, or a path beneath `<root>/`.
 *
 * Returns `false` when no memory layer is configured, leaving the sandbox
 * path untouched for non-memory agents.
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
 * path does not exist.
 */
export async function memoryRead(path: string): Promise<string | null> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return null;
  }

  const relPath = toRelativePath(config, path);
  const bytes = await config.store.read(config.namespace, relPath);

  if (bytes === null) {
    return null;
  }

  return decoder.decode(bytes);
}

/**
 * Writes `content` to a memory path in place. `/memory` is a plain store-backed
 * filesystem: the model writes and overwrites named files (e.g. an `index.md`
 * table of contents, or dated notes if its orientation instructs that).
 *
 * Slice-1 simplification: the idempotency key is content-addressed via
 * `seq: 0` (partitioned by turn id when available), so a replayed identical
 * write collapses to one — replay-safe and idempotent. A monotonic
 * `(turnId, seq)` should be threaded later to keep two distinct-but-identical
 * writes to the same path apart.
 */
export async function memoryWrite(path: string, content: string): Promise<void> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return;
  }

  const relPath = toRelativePath(config, path);
  const bytes = encoder.encode(content);

  const turnId = loadContext().get(SessionKey)?.turn.id ?? "";
  const writeKey = buildWriteKey({
    namespace: config.namespace,
    turnId,
    seq: 0,
    content,
  });
  await config.store.write(config.namespace, relPath, bytes, writeKey);
}

/**
 * Lists memory entries under `prefix`, returning full (root-prefixed) paths.
 */
export async function memoryList(prefix: string): Promise<string[]> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return [];
  }

  const relPrefix = toRelativePrefix(config, prefix);

  const paths: string[] = [];
  const entries = await config.store.list(config.namespace, relPrefix);
  for (const entry of entries) {
    paths.push(`${config.root}/${entry.path}`);
  }
  return paths;
}

/**
 * Searches memory contents under `prefix` for `pattern`, returning matches
 * with full (root-prefixed) paths and 1-based line numbers. Lists entries under
 * the prefix, reads each, and regex-matches lines. `literal` matches the
 * `grep` tool's fixed-string mode by escaping regex metacharacters.
 */
export async function memoryGrep(args: MemoryGrepArgs): Promise<MemoryGrepHit[]> {
  const config = getMemoryConfig();
  if (config === undefined) {
    return [];
  }

  const relPrefix = toRelativePrefix(config, args.prefix);

  const source = args.literal ? escapeRegExp(args.pattern) : args.pattern;
  const flags = args.ignoreCase ? "i" : "";
  const regex = new RegExp(source, flags);

  const entries = await config.store.list(config.namespace, relPrefix);
  const hits: MemoryGrepHit[] = [];

  for (const entry of entries) {
    const bytes = await config.store.read(config.namespace, entry.path);
    if (bytes === null) {
      continue;
    }
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        hits.push({
          path: `${config.root}/${entry.path}`,
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
