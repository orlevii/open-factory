import { expect, test } from "vitest";
import {
  gif,
  gifWithFrame,
  heic,
  jpeg,
  pdf,
  png,
  webp,
  webpLossless,
  webpLossy,
  zip,
} from "./fixtures.ts";
import { imageDimensions, Sniffer, sniffType } from "./sniff.ts";

test("png, jpeg, gif and webp are recognised by their bytes, with header dimensions", () => {
  expect(sniffType(png(640, 480))).toEqual({
    kind: "image",
    mime: "image/png",
    width: 640,
    height: 480,
  });
  expect(sniffType(jpeg(1280, 720))).toMatchObject({
    mime: "image/jpeg",
    width: 1280,
    height: 720,
  });
  // SOF found after a large APP1 (EXIF) segment.
  expect(sniffType(jpeg(300, 200, 60_000))).toMatchObject({ width: 300, height: 200 });
  expect(sniffType(gif(16, 9))).toMatchObject({ mime: "image/gif", width: 16, height: 9 });
  expect(sniffType(webp(4000, 3000))).toMatchObject({
    mime: "image/webp",
    width: 4000,
    height: 3000,
  });
  expect(sniffType(webpLossy(800, 600))).toMatchObject({ width: 800, height: 600 });
  expect(sniffType(webpLossless(123, 45))).toMatchObject({ width: 123, height: 45 });
});

test("UTF-8 text (md, json, csv, code, a BOM) is accepted", () => {
  for (const s of ["# Title\n", '{"a":1}', "a,b\n1,2\n", "const x = 1;\n", "﻿café ✓\n"]) {
    expect(sniffType(Buffer.from(s, "utf8"))).toMatchObject({ kind: "text" });
  }
});

test("a multibyte character split across chunks is still valid UTF-8", () => {
  const bytes = Buffer.from("aé✓b", "utf8");
  const s = new Sniffer();
  for (const b of bytes) s.push(Buffer.from([b]));
  expect(s.finish()).toMatchObject({ kind: "text" });
});

const FILE = { kind: "file", mime: "application/octet-stream" };
test.each([
  ["a zip", zip()],
  ["an all-ASCII PDF", pdf()],
  ["HEIC", heic()],
  ["UTF-16 with a BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")])],
  ["UTF-16 without a BOM", Buffer.from("hi", "utf16le")],
  ["bytes with a NUL", Buffer.from([0x00, 0x01, 0x02, 0x03])],
  ["invalid UTF-8", Buffer.from([0x61, 0xc3, 0x28])],
  ["a truncated multibyte end", Buffer.from([0x61, 0xe2, 0x9c])],
  ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  [
    "SVG behind <?xml",
    Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ],
  ["SVG after whitespace", Buffer.from("  <svg onload=alert(1)>")],
  ["an HTML document", Buffer.from("<!DOCTYPE html><html><script>x</script>")],
  ["HTML after a BOM and newlines", Buffer.from("\uFEFF\n\n<!doctype html><p>x")],
  ["a PNG with an unreadable header", png(10, 10).subarray(0, 18)],
  ["a JPEG with no frame header", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ["a PNG with a zero side", png(0, 10)],
  ["a PNG over 8000 px a side", png(8001, 10)],
  ["a PNG over 50 MP", png(8000, 8000)],
  ["a JPEG over 8000 px", jpeg(9000, 100)],
  ["a WebP over 8000 px", webp(16000, 10)],
  ["a GIF frame over the caps", gifWithFrame(10, 10, 30000, 30000)],
  [
    "HTML behind a GIF magic header",
    Buffer.concat([Buffer.from("GIF89a"), Buffer.from("<html><script>x</script>")]),
  ],
])("%s is an opaque file", (_, data) => expect(sniffType(data)).toEqual(FILE));

test("a NUL far past the head still makes it a file", () => {
  const s = new Sniffer();
  s.push(Buffer.alloc(600 * 1024, 0x61));
  s.push(Buffer.from([0x00]));
  expect(s.finish()).toEqual(FILE);
});

test("the largest accepted image stays an image", () => {
  expect(sniffType(png(8000, 6000))).toMatchObject({ kind: "image" }); // 48 MP
});

test("an empty file is refused", () => {
  expect(sniffType(Buffer.alloc(0))).toEqual({ status: 422, reason: "The file is empty." });
});

test("imageDimensions reads a header without decoding", () => {
  expect(imageDimensions(png(3, 4), "image/png")).toEqual({ width: 3, height: 4 });
  expect(imageDimensions(Buffer.alloc(4), "image/gif")).toBeUndefined();
});

test("review m2: a GIF frame larger than its logical screen sets the dimensions", () => {
  expect(sniffType(gifWithFrame(10, 10, 20, 30))).toMatchObject({
    kind: "image",
    width: 20,
    height: 30,
  });
  expect(sniffType(gifWithFrame(100, 100, 20, 30))).toMatchObject({ width: 100, height: 100 });
});
