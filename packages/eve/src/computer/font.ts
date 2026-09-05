/**
 * A 3x5 uppercase bitmap font.
 *
 * The virtual backend renders labels so a screenshot is readable by a vision
 * model and by a human reviewing an eval failure. A hand-authored 3x5 font
 * keeps that legible without adding a font dependency or a rasterizer.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ["###", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: ["###", "#..", "#..", "#..", "###"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: ["###", "#..", "#.#", "#.#", "###"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", "###"],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["#.#", "###", "###", "###", "#.#"],
  O: ["###", "#.#", "#.#", "#.#", "###"],
  P: ["###", "#.#", "###", "#..", "#.."],
  Q: ["###", "#.#", "#.#", "###", "..#"],
  R: ["###", "#.#", "##.", "#.#", "#.#"],
  S: ["###", "#..", "###", "..#", "###"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", "###", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", "..#", "..#", "..#"],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  " ": ["...", "...", "...", "...", "..."],
  ".": ["...", "...", "...", "...", ".#."],
  ",": ["...", "...", "...", ".#.", "#.."],
  ":": ["...", ".#.", "...", ".#.", "..."],
  "-": ["...", "...", "###", "...", "..."],
  _: ["...", "...", "...", "...", "###"],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "=": ["...", "###", "...", "###", "..."],
  "!": [".#.", ".#.", ".#.", "...", ".#."],
  "?": ["###", "..#", ".##", "...", ".#."],
  "#": ["#.#", "###", "#.#", "###", "#.#"],
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  "(": ["..#", ".#.", ".#.", ".#.", "..#"],
  ")": ["#..", ".#.", ".#.", ".#.", "#.."],
  "*": ["#.#", ".#.", "#.#", "...", "..."],
  "'": [".#.", ".#.", "...", "...", "..."],
  "@": ["###", "#.#", "###", "#..", "###"],
};

export const GLYPH_WIDTH = 3;
export const GLYPH_HEIGHT = 5;
/** Advance per character, in unscaled pixels, including the 1px gap. */
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

/** Width of `text` rendered at `scale`, in pixels. */
export function measureText(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * GLYPH_ADVANCE - 1) * scale;
}

/**
 * Calls `plot` for every lit pixel of `text` drawn with its top-left corner
 * at (`x`, `y`), scaled by `scale`.
 */
export function drawText(
  text: string,
  options: {
    readonly plot: (x: number, y: number) => void;
    readonly scale: number;
    readonly x: number;
    readonly y: number;
  },
): void {
  const { plot, scale, x, y } = options;
  for (const [index, character] of [...text.toUpperCase()].entries()) {
    const glyph = GLYPHS[character] ?? GLYPHS["?"]!;
    const originX = x + index * GLYPH_ADVANCE * scale;
    for (const [row, bits] of glyph.entries()) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (bits[column] !== "#") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            plot(originX + column * scale + dx, y + row * scale + dy);
          }
        }
      }
    }
  }
}
