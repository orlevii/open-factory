import { expect, test } from "vitest";
import { clampSource, longestFence, plainLength, splitBlocks } from "./split-blocks";

test("splits at blank lines before a column-0 line", () => {
  expect(splitBlocks("# Title\n\nOne\ntwo\n\n\nThree").blocks).toEqual([
    "# Title",
    "One\ntwo",
    "Three",
  ]);
  expect(splitBlocks("").blocks).toEqual([]);
});

test("loose lists and indented continuations stay one block", () => {
  expect(splitBlocks("- a\n\n- b\n\n  more b\n\nNext").blocks).toEqual([
    "- a\n\n- b\n\n  more b",
    "Next",
  ]);
  expect(splitBlocks("1. a\n\n2. b").blocks).toEqual(["1. a\n\n2. b"]);
});

test("a quote continued after a blank line stays one block; a paragraph then a list splits", () => {
  expect(splitBlocks("> a\n\n> b\n\nc").blocks).toEqual(["> a\n\n> b", "c"]);
  expect(splitBlocks("Para\n\n- a").blocks).toEqual(["Para", "- a"]);
});

test("never splits inside a fence", () => {
  expect(splitBlocks("```ts\na\n\nb\n```\n\nafter").blocks).toHaveLength(2);
  expect(splitBlocks("~~~\na\n\n```\nb\n~~~\n\nafter").blocks).toEqual([
    "~~~\na\n\n```\nb\n~~~",
    "after",
  ]);
});

test("reports an open fence", () => {
  expect(splitBlocks("x\n\n```py\nprint(1)").openFence).toBe(true);
  expect(splitBlocks("x\n\n```py\nprint(1)\n```").openFence).toBe(false);
});

test("plainLength counts what renders, not the markdown syntax", () => {
  expect(plainLength("# **Bold** and `code`")).toBe("Bold and code".length);
  expect(plainLength("[a link](https://example.com/very/long)")).toBe("a link".length);
  expect(plainLength("- one\n- two")).toBe("onetwo".length);
  expect(plainLength("> quoted")).toBe("quoted".length);
});

test("no clamp when the body is within both limits", () => {
  expect(clampSource("short")).toBeUndefined();
  expect(clampSource(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"))).toBeUndefined();
});

test("a 6,000-char single line clamps at 4,000 rendered chars", () => {
  const out = clampSource("a".repeat(6000));
  expect(out).toBeDefined();
  expect(plainLength(out as string)).toBeLessThanOrEqual(4000);
  expect((out as string).length).toBeLessThanOrEqual(4000);
});

test("many short paragraphs clamp at the last block boundary before 4,000 chars", () => {
  const para = "w".repeat(300);
  const out = clampSource(Array.from({ length: 20 }, () => para).join("\n\n")) as string;
  expect(out.split("\n\n")).toHaveLength(13); // 13 × 300 = 3,900
  expect(out.endsWith(para)).toBe(true);
});

test("the cut never lands inside a fence or table", () => {
  const rows = Array.from({ length: 50 }, (_, i) => `| ${i} | x |`).join("\n");
  const code = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  expect(clampSource(`Intro\n\n| a | b |\n|---|---|\n${rows}\n\nafter`)).toBe("Intro");
  expect(clampSource(`Intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\nafter`)).toBe("Intro");
  // A first block over the limit is cut by lines, its fence closed virtually.
  const own = clampSource(`\`\`\`ts\n${code}\n\`\`\``) as string;
  expect(own.split("\n").length).toBeLessThanOrEqual(41);
  expect(own.startsWith("```ts\nline 0")).toBe(true);
  expect(own.endsWith("\n```")).toBe(true);
  expect(splitBlocks(own).openFence).toBe(false);
});

test("forty lines is the other limit", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `p${i}`).join("\n\n");
  const out = clampSource(lines) as string;
  expect(out.split("\n").length).toBeLessThanOrEqual(40);
  expect(out.endsWith("p19")).toBe(true);
});

test("longestFence: the most code lines in one fence; an unclosed fence counts to the end", () => {
  expect(longestFence("no code")).toBe(0);
  expect(longestFence("a\n\n```\n1\n2\n```\n\n~~~\n1\n2\n3\n~~~")).toBe(3);
  expect(longestFence("```\n1\n2\n3\n4")).toBe(4);
});
