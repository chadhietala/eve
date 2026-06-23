import { describe, expect, test } from "vitest";

import { parseDuration } from "#runtime/transcripts/duration.js";

describe("parseDuration", () => {
  test.each([
    ["90s", 90_000],
    ["45m", 2_700_000],
    ["12h", 43_200_000],
    ["30d", 2_592_000_000],
    ["1.5h", 5_400_000],
    [" 12h ", 43_200_000],
  ])("parses %o → %i ms", (input, expected) => {
    expect(parseDuration(input as string)).toBe(expected);
  });

  test("passes a non-negative number through as milliseconds", () => {
    expect(parseDuration(5_000)).toBe(5_000);
    expect(parseDuration(0)).toBe(0);
  });

  test.each(["", "12", "12x", "h", "-3h", "abc"])("rejects %o", (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid duration/);
  });

  test("rejects a negative or non-finite number", () => {
    expect(() => parseDuration(-1)).toThrow(/Invalid duration/);
    expect(() => parseDuration(Number.NaN)).toThrow(/Invalid duration/);
  });
});
