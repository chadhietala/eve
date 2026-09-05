import { defineDynamic, defineInstructions } from "#public/definitions/instructions.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";
import { createLearningStore } from "#public/memory/learning/store.js";
import { formatDirectives } from "#public/self-improvement/directive.js";
import { DEFAULT_DIRECTIVE_KEY } from "#public/self-improvement/provider.js";

const READ_TIMEOUT_MS = 5_000;

export interface LearnedDirectivesOptions {
  readonly backend?: MemoryDocumentBackend;
  /** Store key holding the agent's directives. Must match `selfImprovement()`. */
  readonly key?: string;
  /** Maximum directives included. Defaults to 24. */
  readonly limit?: number;
  /** Maximum characters contributed. Defaults to 4,000. */
  readonly maxCharacters?: number;
}

/**
 * Dynamic instructions carrying the agent's active learned directives.
 *
 * This is the runtime half of self-modification: what an agent learned about
 * how to work here becomes part of its instructions on the next turn, with no
 * deployment. It resolves at `session.started`, so a directive activated
 * mid-session takes effect in the next session rather than changing the rules
 * under a running conversation.
 *
 * ```ts title="agent/instructions/learned.ts"
 * export { learnedDirectives as default } from "eve/self-improvement";
 * ```
 */
export function learnedDirectives(options: LearnedDirectivesOptions = {}) {
  const key = options.key ?? DEFAULT_DIRECTIVE_KEY;
  const store = createLearningStore({
    backend: options.backend ?? defaultFileMemoryBackend(),
  });
  const formatOptions: { limit?: number; maxCharacters?: number } = {};
  if (options.limit !== undefined) formatOptions.limit = options.limit;
  if (options.maxCharacters !== undefined) formatOptions.maxCharacters = options.maxCharacters;

  return defineDynamic({
    events: {
      "session.started": async () => {
        // Instruction resolution runs before the first model call, so a slow
        // store must not hold a session open indefinitely.
        const records = await store.read({ key, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        const content = formatDirectives(records, formatOptions);
        return content.length === 0 ? null : defineInstructions({ content });
      },
    },
  });
}
