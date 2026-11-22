/** Header-only image bytes for tests: enough for magic and dimensions, never a decodable image. */

export function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; // bit depth
  b[25] = 6; // RGBA
  return b;
}

export function jpeg(width: number, height: number, app1Bytes = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  // APP0 (JFIF)
  parts.push(
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  );
  if (app1Bytes > 0) {
    const seg = Buffer.alloc(4 + app1Bytes);
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg.writeUInt16BE(app1Bytes + 2, 2);
    parts.push(seg);
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  parts.push(sof);
  return Buffer.concat(parts);
}

export function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** An extended (VP8X) WebP header. */
export function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** A lossy (VP8) WebP header. */
export function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(10, 16);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

/** A lossless (VP8L) WebP header. */
export function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

export function heic(): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write("ftypheic", 4, "ascii");
  return b;
}

/** A GIF whose small logical screen hides a frame of `frameW`×`frameH` (after an extension block). */
export function gifWithFrame(
  width: number,
  height: number,
  frameW: number,
  frameH: number,
): Buffer {
  const head = gif(width, height);
  // A graphic control extension: 21 F9 04 <4 bytes> 00.
  const ext = Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0x00]);
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(frameW, 5);
  desc.writeUInt16LE(frameH, 7);
  // LZW code size, one data sub-block, terminator, trailer.
  const data = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
  return Buffer.concat([head, ext, desc, data]);
}
