/**
 * An upload's type comes from its bytes, never its extension or the client's MIME type. PNG, JPEG, GIF and WebP within
 * the size limits (magic bytes, dimensions read from the header only, never decoded) are images; plain UTF-8 text that
 * isn't SVG or HTML markup is text. Everything else is an opaque file, which is only ever served as octet-stream.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export const TEXT_MIME = "text/plain; charset=utf-8";
export const FILE_MIME = "application/octet-stream";
export type Sniffed =
  | { kind: "image"; mime: ImageMime; width: number; height: number }
  | { kind: "text"; mime: typeof TEXT_MIME }
  | { kind: "file"; mime: typeof FILE_MIME };
export type Refusal = { status: 422; reason: string };

export const MAX_IMAGE_SIDE = 8000;
export const MAX_IMAGE_PIXELS = 50_000_000;

/** Enough to reach a JPEG's SOF behind EXIF and other APPn segments (each at most 64 KB). */
const HEAD_BYTES = 512 * 1024;

// WHATWG MIME sniffing's HTML patterns (the ones that are unambiguous markup), each followed by a space or `>`.
const HTML_START =
  /^<(!doctype\s+html|html|head|body|script|iframe|style|title|table|div|font|h1)[\s>]/i;

const FILE = { kind: "file", mime: FILE_MIME } as const;

const eq = (b: Buffer, at: number, bytes: number[]) =>
  b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, at: number, s: string) =>
  b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;

function magic(head: Buffer): ImageMime | undefined {
  if (eq(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (eq(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return "image/gif";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "image/webp";
  return undefined;
}

function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const m = b[i + 1] as number;
    if (m === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return undefined; // end of image or start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return undefined;
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return undefined;
}

/**
 * Review m2: a GIF's logical screen can be small while its frames are huge, so the size is the largest extent of the
 * screen and every image descriptor (`0x2C`: left, top, width, height) found in the head. Block structure only: color
 * tables and data sub-blocks are skipped by their lengths, nothing is decoded.
 */
function gifSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 13) return undefined;
  let width = b.readUInt16LE(6);
  let height = b.readUInt16LE(8);
  const flags = b[10] as number;
  let i = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  const skipSubBlocks = () => {
    while (i < b.length) {
      const len = b[i] as number;
      i += 1 + len;
      if (len === 0) return;
    }
  };
  while (i < b.length) {
    const block = b[i];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      i += 2; // introducer and label
      skipSubBlocks();
    } else if (block === 0x2c) {
      if (i + 10 > b.length) break;
      const left = b.readUInt16LE(i + 1);
      const top = b.readUInt16LE(i + 3);
      width = Math.max(width, left + b.readUInt16LE(i + 5));
      height = Math.max(height, top + b.readUInt16LE(i + 7));
      const f = b[i + 9] as number;
      i += 10 + (f & 0x80 ? 3 * 2 ** ((f & 7) + 1) : 0);
      i += 1; // LZW minimum code size
      skipSubBlocks();
    } else break; // not a GIF block: stop at what the header said
  }
  return { width, height };
}

function webpSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined;
  if (ascii(b, 12, "VP8X"))
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (!eq(b, 23, [0x9d, 0x01, 0x2a])) return undefined;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

/** Width and height from the header alone (PNG IHDR, JPEG SOF, GIF screen, WebP VP8/VP8L/VP8X); never decodes. */
export function imageDimensions(
  head: Buffer,
  mime: ImageMime,
): { width: number; height: number } | undefined {
  switch (mime) {
    case "image/png":
      return head.length >= 24 && ascii(head, 12, "IHDR")
        ? { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
        : undefined;
    case "image/gif":
      return gifSize(head);
    case "image/jpeg":
      return jpegSize(head);
    case "image/webp":
      return webpSize(head);
  }
}

/** Fed the upload's bytes as they stream; `finish()` decides. Keeps only the head and a streaming UTF-8 check. */
export class Sniffer {
  private readonly headChunks: Buffer[] = [];
  private headBytes = 0;
  private total = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  private utf8 = true;
  private nul = false;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < HEAD_BYTES) {
      const part = chunk.subarray(0, HEAD_BYTES - this.headBytes);
      this.headChunks.push(part);
      this.headBytes += part.length;
    }
    if (!this.nul && chunk.includes(0)) this.nul = true;
    if (this.utf8 && !this.nul) {
      try {
        this.decoder.decode(chunk, { stream: true });
      } catch {
        this.utf8 = false;
      }
    }
  }

  finish(): Sniffed | Refusal {
    if (this.total === 0) return { status: 422, reason: "The file is empty." };
    const head = Buffer.concat(this.headChunks);
    const image = magic(head);
    if (image) {
      const size = imageDimensions(head, image);
      if (
        size &&
        size.width >= 1 &&
        size.height >= 1 &&
        size.width <= MAX_IMAGE_SIDE &&
        size.height <= MAX_IMAGE_SIDE &&
        size.width * size.height <= MAX_IMAGE_PIXELS
      )
        return { kind: "image", mime: image, ...size };
      return FILE;
    }
    if (ascii(head, 0, "%PDF-")) return FILE;
    if (this.nul || !this.utf8) return FILE;
    try {
      this.decoder.decode(); // flush: a truncated multibyte sequence at the end throws
    } catch {
      return FILE;
    }
    const start = head
      .toString("utf8", 0, Math.min(head.length, 4096))
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (/^<svg[\s>/]/i.test(start) || /^<!doctype\s+svg/i.test(start)) return FILE;
    if (/^<\?xml/i.test(start) && /<svg[\s>/]/i.test(start)) return FILE;
    if (HTML_START.test(start)) return FILE;
    return { kind: "text", mime: TEXT_MIME };
  }
}

/** The whole file at once (tests, and re-checking a stored file). */
export function sniffType(data: Buffer): Sniffed | Refusal {
  const s = new Sniffer();
  s.push(data);
  return s.finish();
}
