import { describe, expect, it } from "vitest";
import { buildWriteKey } from "#runtime/memory/write-key.js";

describe("buildWriteKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    expect(a).toBe(b);
  });

  it("returns a sha256 hex digest", () => {
    const key = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats string and equivalent bytes content identically", () => {
    const fromString = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    const fromBytes = buildWriteKey({
      content: new TextEncoder().encode("hello"),
      seq: 0,
      turnId: "turn-1",
    });
    expect(fromString).toBe(fromBytes);
  });

  it("varies with content", () => {
    const a = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "world", seq: 0, turnId: "turn-1" });
    expect(a).not.toBe(b);
  });

  it("varies with seq", () => {
    const a = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", seq: 1, turnId: "turn-1" });
    expect(a).not.toBe(b);
  });

  it("varies with turnId", () => {
    const a = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-1" });
    const b = buildWriteKey({ content: "hello", seq: 0, turnId: "turn-2" });
    expect(a).not.toBe(b);
  });
});
