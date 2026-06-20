import type { MemoryNamespace } from "#runtime/memory/types.js";

/** Inputs for resolving an agent-scoped {@link MemoryNamespace}. */
export interface ResolveMemoryNamespaceInput {
  readonly agentId: string;
}

/**
 * Resolves the agent's persistent memory {@link MemoryNamespace} — the curated
 * "memory" area mounted at `/memory` and served by the file-tool redirect.
 *
 * Pure and agent-scoped: `scopeId` is the agent id, so this area is shared
 * across every session and thread of the agent and persists between them. It
 * is the massaged memory the agent actually reads, distinct from the raw
 * session dumps (see {@link resolveSessionsNamespace}).
 */
export function resolveMemoryNamespace(input: ResolveMemoryNamespaceInput): MemoryNamespace {
  return {
    agentId: input.agentId,
    scopeId: input.agentId,
    scopeType: "working",
  };
}

/**
 * Resolves the agent's raw-sessions {@link MemoryNamespace} — the off-mount,
 * immutable area where per-session `transcript.jsonl` dumps land.
 *
 * Pure and agent-scoped. This is the dream's input / source of truth; because
 * it is a different `scopeType` from the mounted memory area, it is never
 * reachable through `/memory` (the redirect serves only the mounted namespace).
 */
export function resolveSessionsNamespace(input: ResolveMemoryNamespaceInput): MemoryNamespace {
  return {
    agentId: input.agentId,
    scopeId: input.agentId,
    scopeType: "sessions",
  };
}
