import type { MemoryNamespace } from "#runtime/memory/types.js";

/**
 * Inputs for resolving the working-memory namespace of a turn.
 *
 * `continuationToken` is the channel thread identity (e.g.
 * `slack:<channelId>:<threadTs>`) when present; otherwise the working scope
 * falls back to the root session id so a turn without a continuation token
 * still gets a stable, per-session partition.
 */
export interface ResolveWorkingNamespaceInput {
  readonly agentId: string;
  readonly continuationToken?: string;
  readonly rootSessionId: string;
}

/**
 * Resolves the `"working"` {@link MemoryNamespace} for a turn.
 *
 * Pure: derives `scopeId` as `continuationToken ?? rootSessionId`. Working
 * memory is thread-scoped when a continuation token exists and session-scoped
 * otherwise.
 */
export function resolveWorkingNamespace(input: ResolveWorkingNamespaceInput): MemoryNamespace {
  return {
    agentId: input.agentId,
    scopeId: input.continuationToken ?? input.rootSessionId,
    scopeType: "working",
  };
}
