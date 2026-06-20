import { describe, expect, it } from "vitest";
import { resolveWorkingNamespace } from "#runtime/memory/namespace.js";

describe("resolveWorkingNamespace", () => {
  it("uses the continuation token as scopeId when present", () => {
    const ns = resolveWorkingNamespace({
      agentId: "agent-1",
      continuationToken: "slack:c1:t1",
      rootSessionId: "session-1",
    });
    expect(ns).toEqual({
      agentId: "agent-1",
      scopeId: "slack:c1:t1",
      scopeType: "working",
    });
  });

  it("falls back to the root session id when no continuation token", () => {
    const ns = resolveWorkingNamespace({ agentId: "agent-1", rootSessionId: "session-1" });
    expect(ns).toEqual({
      agentId: "agent-1",
      scopeId: "session-1",
      scopeType: "working",
    });
  });

  it("always resolves to the working scope type", () => {
    const ns = resolveWorkingNamespace({ agentId: "agent-1", rootSessionId: "session-1" });
    expect(ns.scopeType).toBe("working");
  });
});
