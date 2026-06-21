import { describe, expect, it } from "vitest";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";

describe("resolveStoreNamespace", () => {
  it("resolves a constant curated namespace independent of any name", () => {
    const ns = resolveStoreNamespace();
    expect(ns.scopeType).toBe("store");
    // The partition within a backend is fixed: the backend instance is the
    // identity, so no name/agent id may leak into the namespace.
    expect(ns).toEqual(resolveStoreNamespace());
  });
});

describe("resolveTranscriptsNamespace", () => {
  it("resolves a constant transcripts namespace under the transcripts scope", () => {
    const ns = resolveTranscriptsNamespace();
    expect(ns.scopeType).toBe("transcripts");
    expect(ns).toEqual(resolveTranscriptsNamespace());
  });
});

describe("store vs transcripts namespaces", () => {
  it("differ only in scopeType so dumps never collide with curated memory", () => {
    const curated = resolveStoreNamespace();
    const transcripts = resolveTranscriptsNamespace();
    // Same backend, two areas: distinguished purely by scopeType (curated vs.
    // raw transcripts), never by name — sharing is by backend identity.
    expect(curated.scopeType).not.toBe(transcripts.scopeType);
    expect(curated.agentId).toBe(transcripts.agentId);
    expect(curated.scopeId).toBe(transcripts.scopeId);
  });
});
