import type { SystemModelMessage } from "ai";

import type { ContextKey } from "#context/key.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";

/**
 * Builds the memory "pointer" system messages for the active turn.
 *
 * Returns a single system message orienting the model: its durable memory is a
 * plain filesystem mounted at `root`, followed by the author's orientation text
 * (the `memory.md` body or the `memory.ts` return) injected verbatim. Returns
 * an empty array when memory is not configured for the turn, so non-memory
 * agents are unaffected. Mirrors {@link buildDynamicInstructionMessages}: the
 * tool-loop appends these to the system messages assembled for the model call.
 */
export function buildMemoryOrientationMessages(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): SystemModelMessage[] {
  const config = ctx.get(MemoryConfigKey);
  if (config === undefined) {
    return [];
  }

  const lines = [
    `You have a durable memory filesystem mounted at "${config.root}". Read, write, grep, and list files under it to persist and recall context across turns.`,
  ];

  // The author's orientation (memory.md body / memory.ts return) is injected
  // verbatim — it is guidance, not a file under the mount.
  if (config.orientation !== undefined && config.orientation.trim().length > 0) {
    lines.push(config.orientation.trim());
  }

  return [{ role: "system", content: lines.join("\n\n") }];
}
