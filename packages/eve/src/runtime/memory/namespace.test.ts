import { describe, expect, it } from "vitest";
import { resolveMemoryNamespace, resolveSessionsNamespace } from "#runtime/memory/namespace.js";

describe("resolveMemoryNamespace", () => {
  it("is agent-scoped: scopeId is the agent id under the working scope", () => {
    const ns = resolveMemoryNamespace({ agentId: "agent-1" });
    expect(ns).toEqual({
      agentId: "agent-1",
      scopeId: "agent-1",
      scopeType: "working",
    });
  });
});

describe("resolveSessionsNamespace", () => {
  it("is agent-scoped under the off-mount sessions scope", () => {
    const ns = resolveSessionsNamespace({ agentId: "agent-1" });
    expect(ns).toEqual({
      agentId: "agent-1",
      scopeId: "agent-1",
      scopeType: "sessions",
    });
  });
});

describe("memory vs sessions namespaces", () => {
  it("differ in scopeType for the same agent so dumps never collide with mounted memory", () => {
    const memory = resolveMemoryNamespace({ agentId: "agent-1" });
    const sessions = resolveSessionsNamespace({ agentId: "agent-1" });
    expect(memory.scopeType).not.toBe(sessions.scopeType);
    expect(memory.agentId).toBe(sessions.agentId);
  });
});
