import { createHash } from "node:crypto";
import type { WriteKey } from "#runtime/memory/types.js";

/**
 * The sha256 hex digest of `content`, the canonical content-address used
 * across the memory layer.
 *
 * This is the single hashing primitive: {@link buildWriteKey} folds it into
 * the idempotency key, and the store layer uses it as a content version id
 * (the "version" of a stored path) and as the compare-and-swap precondition.
 * Centralizing it keeps the version id and the write key derived from exactly
 * the same bytes-to-digest mapping.
 */
export function sha256(content: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

/**
 * Deterministic inputs for a single working-memory write.
 *
 * `turnId` and the monotonic in-turn `seq` are already deterministic in the
 * journal; `content` is hashed so identical content under the same coordinates
 * dedups. No clock or randomness participates, so a workflow replay re-issuing
 * the same logical write derives the same key.
 */
export interface BuildWriteKeyInput {
  readonly turnId: string;
  readonly seq: number;
  readonly content: Uint8Array | string;
}

/**
 * Builds the deterministic idempotency {@link WriteKey} for a write.
 *
 * The key is a sha256 hex digest over the `(turnId, seq)` coordinates and the
 * content. Pure: the same input always yields the same key, which is what lets
 * the store treat a replayed write as a no-op.
 */
export function buildWriteKey(input: BuildWriteKeyInput): WriteKey {
  const { turnId, seq, content } = input;
  const contentHash = sha256(content);

  return createHash("sha256")
    .update([turnId, String(seq), contentHash].join(" "))
    .digest("hex");
}
