import { describe, expect, it } from "vitest";
import { buildWriteKey } from "#runtime/memory/write-key.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const namespace: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "slack:c1:t1",
  scopeType: "store",
};

describe("buildWriteKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    expect(a).toBe(b);
  });

  it("returns a sha256 hex digest", () => {
    const key = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats string and equivalent bytes content identically", () => {
    const fromString = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const fromBytes = buildWriteKey({
      content: new TextEncoder().encode("hello"),
      namespace,
      seq: 0,
      turnId: "turn-1",
    });
    expect(fromString).toBe(fromBytes);
  });

  it("varies with content", () => {
    const a = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "world", namespace, seq: 0, turnId: "turn-1" });
    expect(a).not.toBe(b);
  });

  it("varies with seq", () => {
    const a = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", namespace, seq: 1, turnId: "turn-1" });
    expect(a).not.toBe(b);
  });

  it("varies with turnId", () => {
    const a = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-2" });
    expect(a).not.toBe(b);
  });

  it("varies with namespace dimensions", () => {
    const base = buildWriteKey({ content: "hello", namespace, seq: 0, turnId: "turn-1" });
    const otherScope = buildWriteKey({
      content: "hello",
      namespace: { ...namespace, scopeId: "slack:c1:t2" },
      seq: 0,
      turnId: "turn-1",
    });
    const otherAgent = buildWriteKey({
      content: "hello",
      namespace: { ...namespace, agentId: "agent-2" },
      seq: 0,
      turnId: "turn-1",
    });
    expect(base).not.toBe(otherScope);
    expect(base).not.toBe(otherAgent);
  });
});
