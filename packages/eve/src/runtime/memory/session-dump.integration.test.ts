import type { ModelMessage } from "ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import {
  dumpSession,
  formatTranscriptJsonl,
  transcriptPath,
} from "#runtime/memory/session-dump.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const NS: MemoryNamespace = {
  agentId: "notes",
  scopeId: "notes",
  scopeType: "transcripts",
};

const MESSAGES: ModelMessage[] = [
  { role: "user", content: "what is the plan" },
  { role: "assistant", content: "step one, step two" },
];

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

describe("dumpSession (filesystem)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "eve-session-dump-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("persists a dump that a fresh store instance reads back", async () => {
    const first = new FsMemoryStore(baseDir);
    await dumpSession(first, NS, { sessionId: "s-1", messages: MESSAGES, writeKey: "key-1" });

    // A separate instance over the same dir simulates a process restart.
    const second = new FsMemoryStore(baseDir);
    const stored = decode(await second.read(NS, transcriptPath("s-1")));
    expect(stored).toBe(formatTranscriptJsonl(MESSAGES));
  });
});
