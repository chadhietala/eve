import { describe, expect, it } from "vitest";

import { factKey, heuristicDistiller } from "#public/memory/learning/distiller.js";

const signal = new AbortController().signal;

async function distill(text: string) {
  return heuristicDistiller().distill({ kind: "fact", purpose: "profile", signal, text });
}

describe("heuristicDistiller", () => {
  it("extracts stated preferences and standing constraints", async () => {
    const records = await distill(
      [
        "User: I always run migrations before deploying.",
        "Assistant: Understood, I will do that.",
      ].join("\n"),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe("I always run migrations before deploying.");
    expect(records[0]?.kind).toBe("fact");
    expect(records[0]?.key).toBeDefined();
  });

  it("catches a correction, which is the strongest signal a turn carries", async () => {
    const records = await distill("User: Actually, the billing owner is Priya, not Sam.");

    expect(records[0]?.text).toContain("billing owner is Priya");
  });

  it("stays quiet on ordinary conversation", async () => {
    expect(await distill("User: can you summarize this file\nAssistant: Sure.")).toEqual([]);
  });

  it("declines the kinds it cannot do without a model", async () => {
    const procedures = await heuristicDistiller().distill({
      kind: "procedure",
      purpose: "profile",
      signal,
      text: "User: I always run migrations first.",
    });

    expect(procedures).toEqual([]);
  });

  it("drops the transcript speaker prefix from the stored text", async () => {
    const records = await distill("Assistant: I never delete a branch without asking first.");

    expect(records[0]?.text.startsWith("Assistant:")).toBe(false);
  });
});

describe("factKey", () => {
  it("keys two statements about the same subject together", () => {
    expect(factKey("I always use pnpm for this repo.")).toBe(
      factKey("I always use pnpm for that repo!"),
    );
  });

  it("keys statements about different subjects apart", () => {
    expect(factKey("I always use pnpm.")).not.toBe(factKey("I always use npm."));
  });
});
