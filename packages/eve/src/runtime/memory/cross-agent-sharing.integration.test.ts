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
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { recordSessionTurns } from "#runtime/transcripts/record.js";
import { InMemoryTranscriptStore } from "#runtime/transcripts/store.js";
import { sha256 } from "#runtime/memory/write-key.js";

const ROOT = "/mnt/memory";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function decode(bytes: Uint8Array | null): string {
  expect(bytes).not.toBeNull();
  return decoder.decode(bytes as Uint8Array);
}

/** A deterministic mock that returns a fixed curated document (no network). */
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
  readonly transcriptStore?: InMemoryTranscriptStore;
  readonly curated?: string;
}): MemoryConfig {
  const store: MountedStore = {
    name: args.name,
    backend: args.backend,
    mountPath: args.mountPath ?? `${ROOT}/${args.name}`,
    access: args.access ?? "rw",
  };
  // A `run` override writes deterministically (no model tool-calling),
  // since this suite tests backend-identity SHARING, not the dream's internals.
  const dream: MemoryConfig["dream"] =
    args.curated === undefined
      ? {}
      : {
          run: async (ctx) => {
            await ctx.memory.write("notes.md", args.curated as string);
          },
        };
  const config: MemoryConfig = { root: ROOT, stores: [store], dream };
  return args.transcriptStore === undefined
    ? config
    : { ...config, transcriptStore: args.transcriptStore };
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
 * Lists each store's files and assembles the recall block exactly as
 * `seedMemoryConfig.readMemoryListing` does, then attaches it to the config.
 * Inlined here (rather than calling the seed path, which needs a compiled
 * bundle) so the test stays at the integration tier without a fake bundle.
 */
async function withRecall(config: MemoryConfig): Promise<MemoryConfig> {
  const sections: string[] = [];
  for (const store of config.stores) {
    const entries = await store.backend.list("");
    if (entries.length === 0) {
      continue;
    }
    sections.push(`## ${store.name}\n\n${entries.map((entry) => `- ${entry.path}`).join("\n")}`);
  }
  if (sections.length === 0) {
    return config;
  }
  return { ...config, memoryListing: sections.join("\n\n") };
}

describe("cross-agent memory sharing (same backend = shared)", () => {
  // THE CORE CLAIM. Two DISTINCT agents share memory by pointing at the SAME
  // live backend — even under DIFFERENT local names and DIFFERENT mount paths.
  // Sharing is by backend identity, never by name or agent id:
  //   - A store's backend instance is the only identity, so its contents are
  //     identical for every agent on that backend regardless of what each calls
  //     it; the session transcript log is likewise shared by pointing at the same
  //     `transcriptStore`.
  //   - The agent's own id never enters storage resolution; it is not even a
  //     field of MemoryConfig/MountedStore (keys.ts), so it CANNOT influence it.
  it("A's recorded session, dreamed into notes.md, surfaces in B's orientation", async () => {
    // One memory backend instance is THE shared curated storage; one transcript
    // log is THE shared session record. Both agents hold these exact references —
    // that shared reference IS the sharing.
    const shared = new InMemoryMemoryStore();
    const sharedTranscripts = new InMemoryTranscriptStore();
    const CURATED = "# Memory\n\n- EU launch ships July 14 (legal sign-off complete).";

    // Agent A names the backend "notes" and mounts it at /mnt/memory/notes.
    const agentA = singleStoreConfig({
      backend: shared,
      name: "notes",
      mountPath: `${ROOT}/notes`,
      transcriptStore: sharedTranscripts,
      curated: CURATED,
    });
    // Agent B is a DIFFERENT agent: a DIFFERENT local name ("shared") AND mount
    // alias. Neither has any bearing on which store the bytes physically live in
    // — only the backend reference does. If sharing leaked through the name, B
    // would see nothing; this is the point of the test.
    const agentB = singleStoreConfig({
      backend: shared,
      name: "shared",
      mountPath: `${ROOT}/shared`,
      transcriptStore: sharedTranscripts,
    });

    // 1) Agent A's session turns are recorded into the shared transcript log.
    const turns = [
      { role: "user" as const, content: "Ship the EU launch on July 14; legal sign-off is done." },
      { role: "assistant" as const, content: "Noted." },
    ];
    await recordSessionTurns(sharedTranscripts, "a-session-1", turns);

    // Before any dream, B's orientation knows nothing of A's session: the shared
    // backend holds no files yet, so recall surfaces no listing.
    expect(orientationFor(await withRecall(agentB))).not.toContain("notes.md");

    // 2) The dream folds the windowed transcripts into the shared backend.
    //    Run via Agent A's config; because the backend is the only identity (not
    //    name-derived), it writes the same file B sees.
    await runDream(agentA, { model: mockModel(CURATED), now: 0 });

    expect(decode(await shared.read("notes.md"))).toBe(CURATED);

    // The transcript log (the dream's input) is untouched.
    expect(await sharedTranscripts.read("a-session-1")).toEqual(turns);

    // 3) Agent B — the OTHER agent, different name and mount alias — sees the file
    //    A's dream wrote surfaced in its recall listing under B's own mount name:
    //    cross-agent sharing keyed purely on the backend. (B reads the content on
    //    demand; the direct backend read above proves the bytes are shared.)
    const orientationB = orientationFor(await withRecall(agentB));
    expect(orientationB).toContain("Your memory contains these files");
    expect(orientationB).toContain("## shared");
    expect(orientationB).toContain("- notes.md");
  });

  // THE CONVERSE, proved precisely. Backend identity is the sharing key, so two
  // SEPARATE backend instances are isolated even under the SAME name. Sharing
  // never leaks through the name — only a shared backend reference shares.
  it("the same name over two distinct backends does NOT share (backend is the key)", async () => {
    const backendA = new InMemoryMemoryStore();
    const backendB = new InMemoryMemoryStore();
    const NAME = "notes";

    // A dreams against backendA; its curated memory lands in backendA only.
    const transcriptsA = new InMemoryTranscriptStore();
    const agentA = singleStoreConfig({
      backend: backendA,
      name: NAME,
      transcriptStore: transcriptsA,
      curated: "# Memory\n\n- secret code 4815",
    });
    await recordSessionTurns(transcriptsA, "x", [
      { role: "user" as const, content: "A-only secret: code is 4815." },
    ]);
    await runDream(agentA, { model: mockModel("# Memory\n\n- secret code 4815"), now: 0 });

    // B uses the SAME name but a DIFFERENT backend instance. It shares nothing.
    const agentB = singleStoreConfig({ backend: backendB, name: NAME });
    const orientationB = orientationFor(await withRecall(agentB));
    expect(orientationB).not.toContain("4815");
    // Proof the isolation is storage-level: B's backend has no curated memory at
    // all, while A's does.
    expect(await backendB.read("notes.md")).toBeNull();
    expect(await backendA.read("notes.md")).not.toBeNull();
  });

  // CROSS-AGENT CAS: two distinct agents writing the shared curated file race,
  // and the loser's revision is not lost — it survives in `listVersions`. The
  // generic store-access retry/CAS loop is already covered by
  // store-access.test.ts; here we add only the cross-agent angle directly
  // against the store contract: a concurrent write under a stale expectedVersion
  // conflicts, and after the conflict-aware re-read both revisions remain.
  it("a concurrent cross-agent write resolves via CAS without losing history", async () => {
    const shared = new InMemoryMemoryStore();
    const PATH = "notes.md";

    // Agent A writes the head.
    const aBytes = encoder.encode("# Memory\n\n- from agent A");
    await shared.write(PATH, aBytes, "a-key", { expectedVersion: null });

    // Agent B read the (now stale) head as absent and tries to CAS-write against
    // it — simulating B racing A from the moment the file did not yet exist.
    const bBytes = encoder.encode("# Memory\n\n- from agent B");
    await expect(shared.write(PATH, bBytes, "b-key", { expectedVersion: null })).rejects.toThrow(
      /conflict/i,
    );

    // Conflict-aware retry: B re-reads the now-newer head and writes under it.
    const head = await shared.read(PATH);
    await shared.write(PATH, bBytes, "b-key", {
      expectedVersion: head === null ? null : sha256(head),
    });

    // B's content won the head (last-write-wins)...
    expect(decode(await shared.read(PATH))).toBe(decoder.decode(bBytes));
    // ...but A's clobbered revision SURVIVES in the version trail — no write lost.
    const versions = await shared.listVersions(PATH);
    expect(versions.map((v) => v.version)).toEqual([
      sha256(decoder.decode(bBytes)),
      sha256(decoder.decode(aBytes)),
    ]);
    expect(decode(await shared.readVersion(PATH, sha256(decoder.decode(aBytes))))).toBe(
      decoder.decode(aBytes),
    );
  });
});
