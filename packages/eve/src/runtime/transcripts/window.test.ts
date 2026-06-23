import { describe, expect, test } from "vitest";

import {
  DEFAULT_DREAM_WINDOW_MS,
  resolveRetentionCutoff,
  resolveWindow,
} from "#runtime/transcripts/window.js";

describe("resolveWindow", () => {
  test("a lookback selects [now - lookback, now) with an open upper bound", () => {
    expect(resolveWindow(1_000_000, "12h")).toEqual({ since: 1_000_000 - 43_200_000 });
  });

  test("accepts a numeric (ms) lookback", () => {
    expect(resolveWindow(5_000, 1_000)).toEqual({ since: 4_000 });
  });

  test("falls back to the default 24h backstop when no lookback is given", () => {
    expect(resolveWindow(DEFAULT_DREAM_WINDOW_MS)).toEqual({ since: 0 });
  });
});

describe("resolveRetentionCutoff", () => {
  test("returns now - maxAge", () => {
    expect(resolveRetentionCutoff(100_000_000, "30d")).toBe(100_000_000 - 2_592_000_000);
  });

  test("accepts a numeric (ms) maxAge", () => {
    expect(resolveRetentionCutoff(10_000, 3_000)).toBe(7_000);
  });
});
