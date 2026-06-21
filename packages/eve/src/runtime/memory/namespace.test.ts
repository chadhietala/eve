import { describe, expect, it } from "vitest";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";

describe("resolveStoreNamespace", () => {
  it("keys the curated namespace on the store name, not an agent id", () => {
    const ns = resolveStoreNamespace("notes");
    expect(ns).toEqual({
      agentId: "notes",
      scopeId: "notes",
      scopeType: "store",
    });
  });

  it("resolves the same partition for two agents pointing at the same store", () => {
    expect(resolveStoreNamespace("shared")).toEqual(resolveStoreNamespace("shared"));
  });
});

describe("resolveTranscriptsNamespace", () => {
  it("keys the transcripts namespace on the store name under the transcripts scope", () => {
    const ns = resolveTranscriptsNamespace("notes");
    expect(ns).toEqual({
      agentId: "notes",
      scopeId: "notes",
      scopeType: "transcripts",
    });
  });
});

describe("store vs transcripts namespaces", () => {
  it("differ in scopeType for the same store so dumps never collide with curated memory", () => {
    const curated = resolveStoreNamespace("notes");
    const transcripts = resolveTranscriptsNamespace("notes");
    expect(curated.scopeType).not.toBe(transcripts.scopeType);
    expect(curated.scopeId).toBe(transcripts.scopeId);
  });
});
