import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { createTesseractEngine } from "./ocr.js";

/** Мінімальний PNG (біле полотно) без зовнішніх залежностей. */
function whitePng(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h, 0xff);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;                            // filter byte
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

const REAL = process.env.OCR_REAL === "1";

describe.skipIf(!REAL)("Tesseract (реальний рушій)", () => {
  it("ініціалізується і повертає текст/впевненість", async () => {
    const engine = await createTesseractEngine(["eng"]);
    const out = await engine.recognize({ bytes: whitePng(120, 40), mime: "image/png" });
    expect(typeof out.text).toBe("string");
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  }, 240_000);
});
