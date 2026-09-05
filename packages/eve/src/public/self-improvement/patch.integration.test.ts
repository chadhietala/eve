import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecord } from "#public/memory/learning/record.js";
import { withStatus } from "#public/self-improvement/directive.js";
import { applyAgentPatch, renderAgentPatch } from "#public/self-improvement/patch.js";

let appRoot = "";

beforeEach(async () => {
  appRoot = await mkdtemp(join(tmpdir(), "eve-self-improvement-"));
});

afterEach(async () => {
  await rm(appRoot, { force: true, recursive: true });
});

describe("applyAgentPatch", () => {
  it("writes the learned instructions into the agent directory", async () => {
    const patch = renderAgentPatch([
      withStatus(
        createRecord(
          { kind: "directive", text: "Run the migration check before deploying." },
          Date.now(),
          "d1",
        ),
        "active",
      ),
    ]);

    const written = await applyAgentPatch({ appRoot, patch });

    expect(written).toEqual([join("agent", "instructions", "learned.md")]);
    await expect(
      readFile(join(appRoot, "agent", "instructions", "learned.md"), "utf8"),
    ).resolves.toContain("- Run the migration check before deploying.");
  });

  it("replaces the file on a later run instead of appending", async () => {
    const first = renderAgentPatch([
      withStatus(
        createRecord({ kind: "directive", text: "First rule." }, Date.now(), "d1"),
        "active",
      ),
    ]);
    const second = renderAgentPatch([
      withStatus(
        createRecord({ kind: "directive", text: "Second rule." }, Date.now(), "d2"),
        "active",
      ),
    ]);

    await applyAgentPatch({ appRoot, patch: first });
    await applyAgentPatch({ appRoot, patch: second });

    const contents = await readFile(join(appRoot, "agent", "instructions", "learned.md"), "utf8");
    expect(contents).toContain("Second rule.");
    expect(contents).not.toContain("First rule.");
  });
});
