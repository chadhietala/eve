import { describe, expect, it } from "vitest";

import { drawText, GLYPH_HEIGHT, measureText } from "#computer/font.js";

function render(text: string): string {
  const width = measureText(text, 1);
  const rows = Array.from({ length: GLYPH_HEIGHT }, () => Array.from({ length: width }, () => "."));
  drawText(text, {
    plot: (x, y) => {
      rows[y]![x] = "#";
    },
    scale: 1,
    x: 0,
    y: 0,
  });
  return rows.map((row) => row.join("")).join("\n");
}

describe("drawText", () => {
  it("renders uppercase glyphs with a one-pixel gap", () => {
    expect(render("AB")).toBe(["###.##.", "#.#.#.#", "###.##.", "#.#.#.#", "#.#.##."].join("\n"));
  });

  it("folds lowercase onto the uppercase glyph", () => {
    expect(render("e")).toBe(render("E"));
  });

  it("substitutes an unknown character rather than dropping it", () => {
    expect(measureText("~", 1)).toBe(3);
    expect(render("~")).toBe(render("?"));
  });

  it("scales every lit pixel", () => {
    const points: string[] = [];
    drawText("I", { plot: (x, y) => points.push(`${x},${y}`), scale: 2, x: 0, y: 0 });

    expect(points).toContain("0,0");
    expect(points).toContain("1,1");
    expect(measureText("II", 2)).toBe(14);
  });
});
