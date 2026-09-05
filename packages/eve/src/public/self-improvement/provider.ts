import { z } from "#compiled/zod/index.js";

import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";
import { defineMemoryProvider, type MemoryProvider } from "#public/memory/index.js";
import {
  episodic,
  procedural,
  type MemoryArchitecture,
} from "#public/memory/learning/architectures.js";
import type { MemoryDistiller } from "#public/memory/learning/distiller.js";
import { hashingEmbedding, type MemoryEmbedding } from "#public/memory/learning/embedding.js";
import { learningMemory } from "#public/memory/learning/provider.js";
import { createRecord, type MemoryRecord } from "#public/memory/learning/record.js";
import { createLearningStore } from "#public/memory/learning/store.js";
import { experience } from "#public/self-improvement/architecture.js";
import {
  applyPromotionPolicy,
  directiveStatus,
  isDirective,
  resolvePromotionPolicy,
  withApproval,
  withStatus,
  type PromotionPolicy,
} from "#public/self-improvement/directive.js";
import { renderAgentPatch } from "#public/self-improvement/patch.js";

/**
 * Default store key for learned directives.
 *
 * Directives describe how the *agent* behaves, so unlike ordinary memory they
 * are not partitioned by caller. The slot's `scope` still decides which
 * callers the agent is allowed to learn from.
 */
export const DEFAULT_DIRECTIVE_KEY = "eve-self-improvement-v1";

const CANDIDATE_ITEM_ID = "self-improvement-candidates";
const MAX_RECALLED_CANDIDATES = 5;

export interface SelfImprovementOptions {
  /** Additional architectures. Defaults to experience, episodic, and procedural. */
  readonly architectures?: readonly MemoryArchitecture[];
  readonly backend?: MemoryDocumentBackend;
  readonly distiller?: MemoryDistiller;
  readonly embedding?: MemoryEmbedding;
  /** Store key holding the agent's directives. Defaults to {@link DEFAULT_DIRECTIVE_KEY}. */
  readonly key?: string;
  readonly policy?: PromotionPolicy;
}

/**
 * A memory provider that learns rules from experience and manages their
 * lifecycle.
 *
 * It observes turns like any memory provider, but what it writes are
 * *candidate* directives — proposals about how the agent should behave. A
 * candidate changes nothing. It becomes part of the agent's instructions only
 * when the configured gate says so: a person's approval by default, or
 * repeated confirmation when the deployment opts into `autonomous`.
 */
export function selfImprovement(options: SelfImprovementOptions = {}): MemoryProvider {
  const backend = options.backend ?? defaultFileMemoryBackend();
  const key = options.key ?? DEFAULT_DIRECTIVE_KEY;
  const policy = resolvePromotionPolicy(options.policy);
  const embedding = options.embedding ?? hashingEmbedding();
  const store = createLearningStore({ backend });

  const base = {
    architectures: options.architectures ?? [experience(), episodic(), procedural()],
    backend,
    consolidate: (records: readonly MemoryRecord[]) => applyPromotionPolicy(records, policy),
    embedding,
    storeKey: key,
  } as const;
  const inner = learningMemory(
    options.distiller === undefined ? base : { ...base, distiller: options.distiller },
  );

  const update = async (
    signal: AbortSignal,
    mutate: (records: readonly MemoryRecord[]) => readonly MemoryRecord[],
  ) =>
    store.update({
      key,
      mutate: (records) => applyPromotionPolicy(mutate(records), policy),
      now: Date.now(),
      signal,
    });

  return defineMemoryProvider({
    recall: {
      // Active directives reach the model as instructions, not as recalled
      // context. What recall surfaces is the queue waiting on a decision, so
      // the agent can raise it with the person it is talking to.
      async "turn.started"(context) {
        const records = await store.read({ key, signal: context.abortSignal });
        const candidates = records
          .filter((record) => isDirective(record) && directiveStatus(record) === "candidate")
          .toSorted((left, right) => right.confidence - left.confidence)
          .slice(0, MAX_RECALLED_CANDIDATES);
        if (candidates.length === 0) return null;

        return {
          messages: [
            {
              content: [
                `# Proposed operating rules awaiting review (${context.memory.slot})`,
                "",
                "These are proposals this agent has drawn from earlier work. They are not in effect.",
                `Approve one with \`${context.memory.slot}__approve_directive\` only when the person you are working with asks for it.`,
                "",
                ...candidates.map((record) => `[${record.id}] ${record.text}`),
              ].join("\n"),
              id: CANDIDATE_ITEM_ID,
            },
          ],
        };
      },
    },
    capture: inner.capture!,
    async tools(context) {
      const inherited = (await inner.tools?.(context)) ?? {};

      return {
        ...inherited,

        propose_directive: defineTool({
          description:
            "Propose an operating rule for future work in this deployment, e.g. a step to take first or a mistake to avoid. A proposal changes nothing on its own; it waits for approval.",
          async execute(input, toolContext) {
            const now = Date.now();
            const [vector] = await embedding.embed([input.text]);
            const record = withStatus(
              {
                ...createRecord(
                  {
                    confidence: 0.6,
                    importance: input.importance ?? 0.7,
                    key: `directive:proposed:${input.text.slice(0, 64)}`,
                    kind: "directive",
                    text: input.text,
                  },
                  now,
                  `d${now.toString(36)}`,
                ),
                vector: vector!,
                vectorId: embedding.id,
              },
              "candidate",
            );
            await update(toolContext.abortSignal, (records) => [...records, record]);
            return { id: record.id, status: "candidate" };
          },
          inputSchema: z.object({
            importance: z.number().min(0).max(1).optional(),
            text: z.string().min(8).max(512),
          }),
        }),

        approve_directive: defineTool({
          // Approval is the gate that lets learned text reach the agent's
          // instructions, so it is itself gated on a person.
          approval: always(),
          description:
            "Approve a proposed directive so it becomes part of the agent's standing instructions. Requires human approval.",
          async execute(input, toolContext) {
            let found = false;
            await update(toolContext.abortSignal, (records) =>
              records.map((record) => {
                if (record.id !== input.id || !isDirective(record)) return record;
                found = true;
                return withApproval(record);
              }),
            );
            return { approved: found, id: input.id };
          },
          inputSchema: z.object({ id: z.string().min(1).max(64) }),
        }),

        retire_directive: defineTool({
          description:
            "Retire a directive so it stops applying. Use it when a rule turned out to be wrong or no longer holds.",
          async execute(input, toolContext) {
            let found = false;
            await update(toolContext.abortSignal, (records) =>
              records.map((record) => {
                if (record.id !== input.id || !isDirective(record)) return record;
                found = true;
                return withStatus(record, "retired");
              }),
            );
            return { id: input.id, retired: found };
          },
          inputSchema: z.object({ id: z.string().min(1).max(64) }),
        }),

        review_directives: defineTool({
          description:
            "List the agent's learned directives and their status, so a person can decide what to approve or retire.",
          async execute(input, toolContext) {
            const records = await store.read({ key, signal: toolContext.abortSignal });
            const status = input.status;
            return {
              directives: records
                .filter((record) => isDirective(record))
                .filter((record) => status === undefined || directiveStatus(record) === status)
                .map((record) => ({
                  confidence: Math.round(record.confidence * 100) / 100,
                  id: record.id,
                  status: directiveStatus(record),
                  text: record.text,
                })),
            };
          },
          inputSchema: z.object({
            status: z.enum(["candidate", "active", "retired"]).optional(),
          }),
        }),

        export_learned_instructions: defineTool({
          description:
            "Render the active directives as the Markdown file that belongs in the agent's source tree, so the change can be committed.",
          async execute(_input, toolContext) {
            const records = await store.read({ key, signal: toolContext.abortSignal });
            const patch = renderAgentPatch(records);
            return {
              files: patch.files,
              pendingCount: patch.pending.length,
            };
          },
          inputSchema: z.object({}),
        }),
      };
    },
  });
}
