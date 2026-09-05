import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { inMemory } from "#public/memory/file/backends/in-memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type {
  MemoryProvider,
  MemoryTurnCompletedContext,
  MemoryTurnStartedContext,
} from "#public/memory/index.js";
import { deserialize } from "#public/memory/learning/store.js";
import { directiveStatus, isDirective } from "#public/self-improvement/directive.js";
import { DEFAULT_DIRECTIVE_KEY, selfImprovement } from "#public/self-improvement/provider.js";

const signal = new AbortController().signal;
const SCOPE = { key: "caller-scope", namespace: "ns", value: "caller-1" } as const;

function context(input: {
  readonly messages: readonly ModelMessage[];
  readonly sequence?: number;
  readonly turnInput?: readonly ModelMessage[];
}): MemoryTurnStartedContext & MemoryTurnCompletedContext {
  return {
    abortSignal: signal,
    getSandbox: () => Promise.reject(new Error("no sandbox in this test")),
    getSkill: () => {
      throw new Error("no skills in this test");
    },
    memory: { scope: SCOPE, slot: "improve" },
    messages: input.messages,
    operationId: `op-${input.sequence ?? 1}`,
    session: {
      auth: { current: undefined } as never,
      id: "session-1",
      turn: { id: "turn-1" } as never,
    },
    turn: {
      id: `turn-${input.sequence ?? 1}`,
      input: input.turnInput ?? [],
      sequence: input.sequence ?? 1,
    },
  };
}

async function observe(
  provider: MemoryProvider,
  input: { readonly assistantText?: string; readonly sequence: number; readonly userText: string },
): Promise<void> {
  await provider.capture!["turn.completed"]!(
    context({
      messages: [
        { content: input.userText, role: "user" },
        { content: input.assistantText ?? "Done.", role: "assistant" },
      ],
      sequence: input.sequence,
    }),
  );
}

async function readDirectives(backend: MemoryDocumentBackend) {
  const document = await backend.read({ key: DEFAULT_DIRECTIVE_KEY, signal });
  return document === null ? [] : deserialize(document.content).filter(isDirective);
}

async function toolsFor(provider: MemoryProvider) {
  return (await provider.tools!({
    memory: { scope: SCOPE, slot: "improve" },
    turn: { id: "turn-1", input: [], sequence: 1 },
  } as never))!;
}

describe("selfImprovement", () => {
  it("proposes a directive from a correction, and leaves it inactive", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });

    await observe(provider, {
      sequence: 1,
      userText: "From now on, always run the migration check before deploying.",
    });

    const directives = await readDirectives(backend);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.text).toContain("migration check");
    expect(directiveStatus(directives[0]!)).toBe("candidate");
  });

  it("stores directives outside the caller's memory partition", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });

    await observe(provider, { sequence: 1, userText: "From now on, prefer the replica." });

    expect(await backend.read({ key: SCOPE.key, signal })).toBeNull();
    expect(await readDirectives(backend)).toHaveLength(1);
  });

  it("activates a candidate only after approval, and gates approval on a person", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });
    await observe(provider, {
      sequence: 1,
      userText: "From now on, always run the migration check before deploying.",
    });

    const tools = await toolsFor(provider);
    const [candidate] = await readDirectives(backend);

    expect(tools.approve_directive?.approval).toBeDefined();

    const approved = (await tools.approve_directive!.execute(
      { id: candidate!.id } as never,
      { abortSignal: signal } as never,
    )) as { approved: boolean };

    expect(approved.approved).toBe(true);
    expect(directiveStatus((await readDirectives(backend))[0]!)).toBe("active");
  });

  it("activates on repeated confirmation when the deployment opts into autonomy", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend, policy: { mode: "autonomous" } });

    // A tool that already failed here before is what produces a repeatable,
    // verbatim candidate, so confidence can accumulate.
    const failing: readonly ModelMessage[] = [
      { content: "sync the invoices", role: "user" },
      {
        content: [
          { input: {}, toolCallId: "1", toolName: "sync_invoices", type: "tool-call" },
          { input: {}, toolCallId: "2", toolName: "notify", type: "tool-call" },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "error-text", value: "boom" },
            toolCallId: "1",
            toolName: "sync_invoices",
            type: "tool-result",
          },
          {
            output: { type: "text", value: "ok" },
            toolCallId: "2",
            toolName: "notify",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    for (let turn = 1; turn <= 5; turn += 1) {
      await provider.capture!["turn.completed"]!(context({ messages: failing, sequence: turn }));
    }

    const directives = await readDirectives(backend);
    expect(directives.map((record) => directiveStatus(record))).toContain("active");
  });

  it("retires a directive that turned out to be wrong", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });
    await observe(provider, { sequence: 1, userText: "From now on, prefer the replica." });
    const tools = await toolsFor(provider);
    const [candidate] = await readDirectives(backend);

    await tools.retire_directive!.execute(
      { id: candidate!.id } as never,
      { abortSignal: signal } as never,
    );

    expect(directiveStatus((await readDirectives(backend))[0]!)).toBe("retired");
  });

  it("recalls candidates awaiting review, and nothing once they are handled", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });

    expect(await provider.recall["turn.started"](context({ messages: [] }))).toBeNull();

    await observe(provider, { sequence: 1, userText: "From now on, prefer the replica." });
    const recalled = await provider.recall["turn.started"](context({ messages: [], sequence: 2 }));

    expect(recalled?.messages[0]?.content).toContain("awaiting review");
    expect(recalled?.messages[0]?.content).toContain("not in effect");
  });

  it("reports the directive queue and renders the committable file", async () => {
    const backend = inMemory();
    const provider = selfImprovement({ backend });
    await observe(provider, { sequence: 1, userText: "From now on, prefer the replica." });
    const tools = await toolsFor(provider);
    const [candidate] = await readDirectives(backend);

    const review = (await tools.review_directives!.execute(
      { status: "candidate" } as never,
      { abortSignal: signal } as never,
    )) as { directives: readonly { id: string }[] };
    expect(review.directives.map((entry) => entry.id)).toEqual([candidate!.id]);

    await tools.approve_directive!.execute(
      { id: candidate!.id } as never,
      { abortSignal: signal } as never,
    );
    const exported = (await tools.export_learned_instructions!.execute(
      {} as never,
      { abortSignal: signal } as never,
    )) as { files: readonly { contents: string; path: string }[]; pendingCount: number };

    expect(exported.files[0]?.path).toBe("agent/instructions/learned.md");
    expect(exported.files[0]?.contents).toContain("prefer the replica");
    expect(exported.pendingCount).toBe(0);
  });
});
