/**
 * Parsing for the {@link Duration} surface type — the dream's lookback window
 * and transcript retention both accept either a number of milliseconds or a
 * short suffix string (`"30d"`, `"12h"`, `"45m"`, `"90s"`).
 */

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type DurationUnit = keyof typeof UNIT_MS;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/;

/**
 * Normalizes a {@link Duration} to milliseconds.
 *
 * A number passes through unchanged (already milliseconds). A string is a
 * positive amount followed by a unit suffix — `s`, `m`, `h`, or `d`. Throws on
 * any other shape so a typo in `"30d"` fails loudly at config time rather than
 * silently selecting the wrong window.
 */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Invalid duration: ${value}. Expected a non-negative number of milliseconds.`,
      );
    }
    return value;
  }

  const match = DURATION_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error(
      `Invalid duration: "${value}". Expected a number of milliseconds or a string like "30d", "12h", "45m", "90s".`,
    );
  }

  const amount = match[1] as string;
  const unit = match[2] as DurationUnit;
  return Number(amount) * UNIT_MS[unit];
}
