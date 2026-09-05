import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Minimal RGBA PNG encoder.
 *
 * The virtual computer backend needs to hand the model a real image without
 * pulling an image library into eve's runtime dependencies. PNG's stored
 * form is a zlib stream of filtered scanlines, and `node:zlib` already ships
 * the only hard part.
 */
export function encodePng(input: {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly width: number;
}): Buffer {
  const { height, pixels, width } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("PNG dimensions must be positive integers.");
  }
  if (pixels.length !== width * height * 4) {
    throw new TypeError("PNG pixel buffer must hold exactly width * height RGBA bytes.");
  }

  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }

  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
