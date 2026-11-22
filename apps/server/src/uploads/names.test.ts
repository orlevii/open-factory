import { expect, test } from "vitest";
import { MAX_SAFE_NAME_BYTES, safeUploadName, storedUploadName } from "./names.ts";

const ok = (s: string) => {
  expect(s).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES);
  expect(s).not.toContain("..");
  expect(s.startsWith(".")).toBe(false);
};

test("only [A-Za-z0-9._-] survive; every other character becomes '-'", () => {
  expect(safeUploadName("notes [draft].md")).toBe("notes--draft-.md");
  expect(safeUploadName("a]b.txt")).toBe("a-b.txt");
  ok(safeUploadName("a]b.txt"));
});

test("U+202E (right-to-left override) can't disguise the extension", () => {
  const s = safeUploadName("invoice‮gnp.exe");
  ok(s);
  expect(s).toBe("invoice-gnp.exe");
});

test("NFC first: an NFD é is one character, so one '-'", () => {
  const nfd = "café.png";
  const nfc = "café.png";
  expect(safeUploadName(nfd)).toBe("caf-.png");
  expect(safeUploadName(nfd)).toBe(safeUploadName(nfc));
});

test("a 200-character name is capped at 80 bytes and keeps its extension", () => {
  const s = safeUploadName(`${"x".repeat(200)}.jpeg`);
  ok(s);
  expect(s.length).toBe(80);
  expect(s.endsWith(".jpeg")).toBe(true);
  const wide = safeUploadName(`${"é".repeat(200)}.txt`);
  ok(wide);
  expect(wide.endsWith(".txt")).toBe(true);
});

test("'..' and leading dots never survive", () => {
  for (const n of ["..", "../../etc/passwd", "..png", ".hidden", "a..b.txt", "/", "", "...."]) {
    ok(safeUploadName(n));
  }
  expect(safeUploadName("../../etc/passwd")).toBe("-.-etc-passwd");
  expect(safeUploadName("a..b.txt")).toBe("a.b.txt");
  expect(safeUploadName("")).toBe("file");
});

test("the stored name is <yyyymmdd>-<id>-<safe>", () => {
  expect(storedUploadName(new Date("2026-11-22T10:00:00Z"), "abc", "x y.png")).toBe(
    "20261122-abc-x-y.png",
  );
});
