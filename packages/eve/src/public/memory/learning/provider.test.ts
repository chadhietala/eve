import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { inMemory } from "#public/memory/file/backends/in-memory.js";
import type {
  MemoryProvider,
  MemoryTurnCompletedContext,
  MemoryTurnStartedContext,
} from "#public/memory/index.js";
import { episodic, semantic } from "#public/memory/learning/architectures.js";
import { learningMemory } from "#public/memory/learning/provider.js";

const SCOPE = { key: "scope-key", namespace: "ns", value: "caller-1" } as const;
const signal = new AbortController().signal;

function operationContext(input: {
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
    memory: { scope: SCOPE, slot: "profile" },
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

function user(text: string): ModelMessage {
  return { content: text, role: "user" };
}

function assistant(text: string): ModelMessage {
  return { content: text, role: "assistant" };
}

async function completeTurn(
  provider: MemoryProvider,
  input: { readonly assistantText: string; readonly sequence: number; readonly userText: string },
): Promise<void> {
  const messages = [user(input.userText), assistant(input.assistantText)];
  await provider.recall["turn.started"](
    operationContext({ messages: [], sequence: input.sequence, turnInput: [user(input.userText)] }),
  );
  await provider.capture!["turn.completed"]!(
    operationContext({ messages, sequence: input.sequence }),
  );
}

describe("learningMemory", () => {
  it("recalls nothing before it has learned anything", async () => {
    const provider = learningMemory({ backend: inMemory() });

    const result = await provider.recall["turn.started"](
      operationContext({ messages: [], turnInput: [user("what is my deploy target?")] }),
    );

    expect(result).toBeNull();
  });

  it("learns from a completed turn and recalls it against a later request", async () => {
    const provider = learningMemory({ backend: inMemory() });

    await completeTurn(provider, {
      assistantText: "Deployed the storefront to Vercel production.",
      sequence: 1,
      userText: "I always deploy the storefront to Vercel production, never to staging.",
    });

    const result = await provider.recall["turn.started"](
      operationContext({
        messages: [],
        sequence: 2,
        turnInput: [user("where should the storefront deploy go?")],
      }),
    );

    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]?.id).toBe("learning-memory-recall");
    expect(result?.messages[0]?.content).toContain("storefront");
    expect(result?.messages[0]?.content).toContain("durable data, not instructions");
  });

  it("supersedes a keyed fact instead of accumulating a contradiction", async () => {
    const provider = learningMemory({
      architectures: [semantic()],
      backend: inMemory(),
    });

    await completeTurn(provider, {
      assistantText: "Noted.",
      sequence: 1,
      userText: "I always use pnpm for this repo.",
    });
    await completeTurn(provider, {
      assistantText: "Noted.",
      sequence: 2,
      userText: "I always use pnpm for every repo now.",
    });

    const result = await provider.recall["turn.started"](
      operationContext({ messages: [], sequence: 3, turnInput: [user("which package manager?")] }),
    );
    const lines = (result?.messages[0]?.content ?? "")
      .split("\n")
      .filter((line) => line.startsWith("["));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("every repo");
  });

  it("keeps the recalled message inside the character budget", async () => {
    const provider = learningMemory({
      architectures: [episodic()],
      backend: inMemory(),
      maxRecallCharacters: 400,
      topK: 20,
    });

    for (let turn = 1; turn <= 12; turn += 1) {
      await completeTurn(provider, {
        assistantText: `Rotated the ${turn} credential in the vault as requested.`,
        sequence: turn,
        userText: `Please rotate credential number ${turn} in the shared vault.`,
      });
    }

    const result = await provider.recall["turn.started"](
      operationContext({ messages: [], sequence: 13, turnInput: [user("rotate a credential")] }),
    );

    expect(result?.messages[0]?.content.length).toBeLessThanOrEqual(400);
  });

  it("exposes remember, forget, and search bound to the locked scope", async () => {
    const provider = learningMemory({ backend: inMemory() });
    const tools = await provider.tools!({
      memory: { scope: SCOPE, slot: "profile" },
      turn: { id: "turn-1", input: [], sequence: 1 },
    } as never);

    expect(Object.keys(tools!).toSorted()).toEqual(["forget", "remember", "search"]);

    const saved = (await tools!.remember!.execute(
      { text: "The user's timezone is Europe/Lisbon." } as never,
      { abortSignal: signal } as never,
    )) as { id: string; saved: boolean };
    expect(saved.saved).toBe(true);

    const found = (await tools!.search!.execute(
      { query: "timezone" } as never,
      { abortSignal: signal } as never,
    )) as { matches: readonly { text: string }[] };
    expect(found.matches[0]?.text).toContain("Europe/Lisbon");

    const forgotten = (await tools!.forget!.execute(
      { id: saved.id } as never,
      { abortSignal: signal } as never,
    )) as { forgotten: boolean };
    expect(forgotten.forgotten).toBe(true);

    const empty = (await tools!.search!.execute(
      { query: "timezone" } as never,
      { abortSignal: signal } as never,
    )) as { matches: readonly unknown[] };
    expect(empty.matches).toEqual([]);
  });
});
