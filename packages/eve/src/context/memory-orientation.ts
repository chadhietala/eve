import type { SystemModelMessage } from "ai";

import type { ContextKey } from "#context/key.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";

/**
 * Builds the memory "pointer" system messages for the active turn.
 *
 * Returns a single system message orienting the model: its durable memory is a
 * plain filesystem mounted at `root`, followed by the author's orientation text
 * (the `memory.ts` return) injected verbatim. Returns an empty array when memory
 * is not configured for the turn, so non-memory agents are unaffected. Mirrors
 * {@link buildDynamicInstructionMessages}: the tool-loop appends these to the
 * system messages assembled for the model call.
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

  // The author's orientation (the `memory.ts` return) is injected verbatim —
  // it is guidance, not a file under the mount.
  if (config.orientation !== undefined && config.orientation.trim().length > 0) {
    lines.push(config.orientation.trim());
  }

  // A listing of each store's files is injected, labeled by store, so the agent
  // knows what memory exists from turn one and can read or grep it on demand.
  if (config.memoryListing !== undefined && config.memoryListing.trim().length > 0) {
    lines.push(
      `Your memory contains these files (read them as needed):\n\n${config.memoryListing.trim()}`,
    );
  }

  return [{ role: "system", content: lines.join("\n\n") }];
}
