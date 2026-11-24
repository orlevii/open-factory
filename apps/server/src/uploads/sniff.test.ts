import { expect, test } from "vitest";
import { gif, gifWithFrame, heic, jpeg, png, webp, webpLossless, webpLossy } from "./fixtures.ts";
import { IMAGE_TOO_LARGE, imageDimensions, Sniffer, sniffType } from "./sniff.ts";

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

test("the extension is not trusted: a PNG named .txt is a PNG, text named .png is text", () => {
  expect(sniffType(png(10, 10), "notes.txt")).toMatchObject({ kind: "image", mime: "image/png" });
  expect(sniffType(Buffer.from("hello\n"), "photo.png")).toEqual({
    kind: "text",
    mime: "text/plain; charset=utf-8",
  });
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

test("SVG, HTML, HEIC, UTF-16, PDF, binary and invalid UTF-8 are refused with 415 and a reason", () => {
  const svg = sniffType(
    Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
  );
  expect(svg).toEqual({ status: 415, reason: "SVG isn't supported; export it as PNG." });
  expect(sniffType(Buffer.from("  <svg onload=alert(1)>"))).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from("<!DOCTYPE html><html><script>x</script>"))).toEqual({
    status: 415,
    reason: "HTML files aren't supported.",
  });
  expect(sniffType(Buffer.from("\n<HTML><body>hi"))).toMatchObject({ status: 415 });
  // An extension that names markup is refused even when the bytes look like plain text.
  expect(sniffType(Buffer.from("hello"), "page.html")).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from("hello"), "icon.svg")).toMatchObject({ status: 415 });
  expect(sniffType(heic())).toEqual({
    status: 415,
    reason: "HEIC isn't supported; export as JPEG",
  });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
  expect(sniffType(utf16)).toEqual({
    status: 415,
    reason: "UTF-16 text isn't supported; save it as UTF-8.",
  });
  expect(sniffType(Buffer.from("hi", "utf16le"))).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from("%PDF-1.7\n"))).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from([0x61, 0xc3, 0x28]))).toMatchObject({ status: 415 });
});

test("over 8000 px a side or 50 MP is 422, read from the header only", () => {
  expect(sniffType(png(30000, 30000))).toEqual({ status: 422, reason: IMAGE_TOO_LARGE });
  expect(sniffType(png(8001, 10))).toMatchObject({ status: 422 });
  expect(sniffType(png(8000, 8000))).toMatchObject({ status: 422 }); // 64 MP
  expect(sniffType(png(8000, 6000))).toMatchObject({ kind: "image" }); // 48 MP
  expect(sniffType(jpeg(9000, 100))).toMatchObject({ status: 422 });
  expect(sniffType(gif(65535, 1))).toMatchObject({ status: 422 });
  expect(sniffType(webp(16000, 10))).toMatchObject({ status: 422 });
});

test("an image whose dimensions can't be read is refused", () => {
  expect(sniffType(png(10, 10).subarray(0, 18))).toMatchObject({ status: 415 });
  expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toMatchObject({ status: 415 });
  expect(sniffType(png(0, 10))).toMatchObject({ status: 415 });
});

test("an empty file is refused", () => {
  expect(sniffType(Buffer.alloc(0))).toEqual({ status: 422, reason: "The file is empty." });
});

test("imageDimensions reads a header without decoding", () => {
  expect(imageDimensions(png(3, 4), "image/png")).toEqual({ width: 3, height: 4 });
  expect(imageDimensions(Buffer.alloc(4), "image/gif")).toBeUndefined();
});

test("review m2: a GIF frame larger than its logical screen is held to the same caps", () => {
  expect(sniffType(gifWithFrame(10, 10, 30000, 30000))).toEqual({
    status: 422,
    reason: IMAGE_TOO_LARGE,
  });
  expect(sniffType(gifWithFrame(10, 10, 20, 30))).toMatchObject({
    kind: "image",
    width: 20,
    height: 30,
  });
  expect(sniffType(gifWithFrame(100, 100, 20, 30))).toMatchObject({ width: 100, height: 100 });
});
