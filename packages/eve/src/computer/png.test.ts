import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { encodePng } from "#computer/png.js";

function solid(width: number, height: number, rgba: readonly number[]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index);
  return pixels;
}

describe("encodePng", () => {
  it("writes a decodable PNG with the requested dimensions", () => {
    const png = encodePng({ height: 3, pixels: solid(5, 3, [10, 20, 30, 255]), width: 5 });

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(5);
    expect(png.readUInt32BE(20)).toBe(3);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  it("round-trips pixel data through the IDAT stream", () => {
    const pixels = solid(2, 2, [1, 2, 3, 255]);
    const png = encodePng({ height: 2, pixels, width: 2 });

    const idatStart = png.indexOf(Buffer.from("IDAT", "ascii"));
    const length = png.readUInt32BE(idatStart - 4);
    const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + length));

    // Each scanline is a zero filter byte followed by RGBA bytes.
    expect([...raw]).toEqual([0, 1, 2, 3, 255, 1, 2, 3, 255, 0, 1, 2, 3, 255, 1, 2, 3, 255]);
  });

  it("rejects a pixel buffer that does not match the dimensions", () => {
    expect(() => encodePng({ height: 2, pixels: new Uint8Array(4), width: 2 })).toThrow(
      /exactly width \* height RGBA bytes/,
    );
  });
});
