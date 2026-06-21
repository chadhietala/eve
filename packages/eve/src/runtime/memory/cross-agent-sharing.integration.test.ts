import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { buildMemoryOrientationMessages } from "#context/memory-orientation.js";
import {
  type BootstrapGenerateOptions,
  createBootstrapGenerateResult,
} from "#runtime/agent/bootstrap-model-utils.js";
import { runDream } from "#runtime/memory/dream.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import { dumpSession, formatTranscriptJsonl } from "#runtime/memory/session-dump.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { buildWriteKey, sha256 } from "#runtime/memory/write-key.js";

const ROOT = "/mnt/memory";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function decode(bytes: Uint8Array | null): string {
  expect(bytes).not.toBeNull();
  return decoder.decode(bytes as Uint8Array);
}

/** A deterministic mock that returns a fixed consolidated document (no network). */
function mockModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    modelId: "mock-dream-model",
    provider: "eve-test",
    doGenerate: async (_options: BootstrapGenerateOptions) =>
      createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-dream-model",
        outputTokens: 1,
        text,
      }),
  });
}

/**
 * Builds a single-store {@link MemoryConfig} for one agent. The agent's own
 * identity is deliberately NOT a parameter: the config carries only the mount
 * root, the live `backend`, the local `mountPath` alias, and the access. This
 * mirrors what `buildMemoryConfigForBundle` produces — a per-agent projection
 * whose only durable identity is `backend` (the live store instance). The
 * `name` is a local mount alias, never the sharing key.
 */
function singleStoreConfig(args: {
  readonly backend: MountedStore["backend"];
  readonly name: string;
  readonly access?: MountedStore["access"];
  readonly mountPath?: string;
}): MemoryConfig {
  const store: MountedStore = {
    name: args.name,
    backend: args.backend,
    mountPath: args.mountPath ?? `${ROOT}/${args.name}`,
    access: args.access ?? "rw",
  };
  return { root: ROOT, stores: [store], dream: {} };
}

/** Renders what an agent would see in its orientation prompt for a given config. */
function orientationFor(config: MemoryConfig): string {
  const ctx = new ContextContainer();
  ctx.set(MemoryConfigKey, config);
  return buildMemoryOrientationMessages(ctx)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

/**
 * Reads each store's curated `MEMORY.md` and assembles the recall block exactly
 * as `seedMemoryConfig.readMemoryIndexes` does, then attaches it to the config.
 * Inlined here (rather than calling the seed path, which needs a compiled
 * bundle) so the test stays at the integration tier without a fake bundle.
 */
async function withRecall(config: MemoryConfig): Promise<MemoryConfig> {
  const sections: string[] = [];
  for (const store of config.stores) {
    const bytes = await store.backend.read(resolveStoreNamespace(), "MEMORY.md");
    if (bytes === null) {
      continue;
    }
    sections.push(`## ${store.name}\n\n${decoder.decode(bytes)}`);
  }
  if (sections.length === 0) {
    return config;
  }
  return { ...config, memoryIndex: sections.join("\n\n") };
}

describe("cross-agent memory sharing (same backend = shared)", () => {
  // THE CORE CLAIM. Two DISTINCT agents share memory by pointing at the SAME
  // live backend — even under DIFFERENT local names and DIFFERENT mount paths.
  // Sharing is by backend identity, never by name or agent id:
  //   - `resolveStoreNamespace()` / `resolveTranscriptsNamespace()` are constant
  //     within a backend (namespace.ts), so the curated and transcripts
  //     partitions are identical for every agent on that backend regardless of
  //     what each calls it.
  //   - The agent's own id never enters the namespace; it is not even a field of
  //     MemoryConfig/MountedStore (keys.ts), so it CANNOT influence resolution.
  it("A's dumped transcript, dreamed into MEMORY.md, surfaces in B's orientation", async () => {
    // One backend instance is THE shared storage. Both agents below hold a
    // reference to this exact object — that shared reference IS the sharing.
    const shared = new InMemoryMemoryStore();

    // Agent A names the backend "notes" and mounts it at /mnt/memory/notes.
    const agentA = singleStoreConfig({
      backend: shared,
      name: "notes",
      mountPath: `${ROOT}/notes`,
    });
    // Agent B is a DIFFERENT agent: a different config, a DIFFERENT local name
    // ("shared") AND a DIFFERENT mount alias. Neither the name nor the mount
    // path has any bearing on which namespace the bytes live in — only the
    // backend reference does. If sharing leaked through the name, B would see
    // nothing; this is the point of the test.
    const agentB = singleStoreConfig({
      backend: shared,
      name: "shared",
      mountPath: `${ROOT}/shared`,
    });

    // 1) Agent A's session transcript is dumped off-mount into the shared store's
    //    transcripts namespace (constant within the backend, so it is the same
    //    area any agent on this backend would dump to or read from).
    const transcriptsNs = resolveTranscriptsNamespace();
    const transcript = [
      { role: "user" as const, content: "Ship the EU launch on July 14; legal sign-off is done." },
      { role: "assistant" as const, content: "Noted." },
    ];
    const raw = formatTranscriptJsonl(transcript);
    await dumpSession(shared, transcriptsNs, {
      sessionId: "a-session-1",
      messages: transcript,
      writeKey: buildWriteKey({
        namespace: transcriptsNs,
        turnId: "a-session-1",
        seq: 0,
        content: raw,
      }),
    });

    // Before any dream, B's orientation knows nothing of A's session: recall reads
    // the curated MEMORY.md, which does not exist yet. This pins that the sharing
    // we assert later is genuinely produced by the dream, not pre-seeded.
    expect(orientationFor(await withRecall(agentB))).not.toContain("July 14");

    // 2) The per-store dream consolidates the shared backend's transcripts into its
    //    curated MEMORY.md. We run it via Agent A's config, but because the dream
    //    resolves its namespaces from the backend (constant, not name-derived), it
    //    reads the same transcripts and writes the same curated MEMORY.md B sees.
    const CONSOLIDATED = "# Memory\n\n- EU launch ships July 14 (legal sign-off complete).";
    await runDream(agentA, { model: mockModel(CONSOLIDATED) });

    // The consolidated fact landed in the shared curated namespace...
    const curatedNs = resolveStoreNamespace();
    expect(decode(await shared.read(curatedNs, "MEMORY.md"))).toBe(CONSOLIDATED);

    // ...and the raw transcript is byte-for-byte UNTOUCHED — the safe property:
    // a dream consolidates into curated memory and never mutates its source.
    expect(decode(await shared.read(transcriptsNs, "transcripts/a-session-1.jsonl"))).toBe(raw);

    // 3) Agent B — the OTHER agent, with a different name and mount alias — recalls
    //    the consolidated MEMORY.md in its orientation. B sees what A learned.
    //    THIS is cross-agent sharing, keyed purely on the backend.
    const orientationB = orientationFor(await withRecall(agentB));
    expect(orientationB).toContain("Your consolidated memory");
    expect(orientationB).toContain("## shared");
    expect(orientationB).toContain("EU launch ships July 14");
  });

  // THE CONVERSE, proved precisely. Backend identity is the sharing key, so two
  // SEPARATE backend instances are isolated even under the SAME name. Sharing
  // never leaks through the name — only a shared backend reference shares.
  it("the same name over two distinct backends does NOT share (backend is the key)", async () => {
    const backendA = new InMemoryMemoryStore();
    const backendB = new InMemoryMemoryStore();
    const NAME = "notes";

    // A dreams against backendA; its curated memory lands in backendA only.
    const agentA = singleStoreConfig({ backend: backendA, name: NAME });
    const transcriptsNs = resolveTranscriptsNamespace();
    const transcript = [{ role: "user" as const, content: "A-only secret: code is 4815." }];
    const raw = formatTranscriptJsonl(transcript);
    await dumpSession(backendA, transcriptsNs, {
      sessionId: "x",
      messages: transcript,
      writeKey: buildWriteKey({ namespace: transcriptsNs, turnId: "x", seq: 0, content: raw }),
    });
    await runDream(agentA, { model: mockModel("# Memory\n\n- secret code 4815") });

    // B uses the SAME name but a DIFFERENT backend instance. It shares nothing.
    const agentB = singleStoreConfig({ backend: backendB, name: NAME });
    const orientationB = orientationFor(await withRecall(agentB));
    expect(orientationB).not.toContain("4815");
    // Proof the isolation is storage-level: B's backend has no curated memory at
    // all, while A's does.
    expect(await backendB.read(resolveStoreNamespace(), "MEMORY.md")).toBeNull();
    expect(await backendA.read(resolveStoreNamespace(), "MEMORY.md")).not.toBeNull();
  });

  // CROSS-AGENT CAS: two distinct agents writing the shared curated file race,
  // and the loser's revision is not lost — it survives in `listVersions`. The
  // generic redirect retry/CAS loop is already covered by the redirect tests
  // (memory-redirect.test.ts); here we add only the cross-agent angle directly
  // against the store contract: a concurrent write under a stale expectedVersion
  // conflicts, and after the conflict-aware re-read both revisions remain.
  it("a concurrent cross-agent write resolves via CAS without losing history", async () => {
    const shared = new InMemoryMemoryStore();
    const ns = resolveStoreNamespace();
    const PATH = "MEMORY.md";

    // Agent A writes the head.
    const aBytes = encoder.encode("# Memory\n\n- from agent A");
    await shared.write(ns, PATH, aBytes, "a-key", { expectedVersion: null });

    // Agent B read the (now stale) head as absent and tries to CAS-write against
    // it — simulating B racing A from the moment the file did not yet exist.
    const bBytes = encoder.encode("# Memory\n\n- from agent B");
    await expect(
      shared.write(ns, PATH, bBytes, "b-key", { expectedVersion: null }),
    ).rejects.toThrow(/conflict/i);

    // Conflict-aware retry: B re-reads the now-newer head and writes under it.
    const head = await shared.read(ns, PATH);
    await shared.write(ns, PATH, bBytes, "b-key", {
      expectedVersion: head === null ? null : sha256(head),
    });

    // B's content won the head (last-write-wins)...
    expect(decode(await shared.read(ns, PATH))).toBe(decoder.decode(bBytes));
    // ...but A's clobbered revision SURVIVES in the version trail — no write lost.
    const versions = await shared.listVersions(ns, PATH);
    expect(versions.map((v) => v.version)).toEqual([
      sha256(decoder.decode(bBytes)),
      sha256(decoder.decode(aBytes)),
    ]);
    expect(decode(await shared.readVersion(ns, PATH, sha256(decoder.decode(aBytes))))).toBe(
      decoder.decode(aBytes),
    );
  });
});
