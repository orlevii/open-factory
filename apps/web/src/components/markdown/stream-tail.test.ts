import { expect, test } from "vitest";
import { prepareTail } from "./stream-tail";

const md = (tail: string) => {
  const r = prepareTail(tail);
  if (r.kind !== "markdown") throw new Error(`expected markdown, got ${r.kind}`);
  return r.source;
};

test("an open fence is plain code in frozen 50-line slices", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
  const r = prepareTail(`\`\`\`ts\n${lines.join("\n")}`);
  expect(r).toMatchObject({ kind: "fence", lang: "ts" });
  if (r.kind !== "fence") return;
  expect(r.slices).toHaveLength(3);
  expect(r.slices[0]).toBe(`${lines.slice(0, 50).join("\n")}\n`);
  expect(r.slices.join("")).toBe(lines.join("\n"));
  // Growth leaves the earlier slices as they were.
  const more = prepareTail(`\`\`\`ts\n${lines.join("\n")}\nline 120`);
  expect(more.kind === "fence" && more.slices.slice(0, 2)).toEqual(r.slices.slice(0, 2));
  // No language: no lang.
  expect(prepareTail("~~~\nx")).toEqual({ kind: "fence", slices: ["x"] });
});

test("an open fence keeps the lines before it as markdown", () => {
  expect(prepareTail("Here it is:\n```py\nprint(1)")).toEqual({
    kind: "fence",
    lead: "Here it is:",
    lang: "py",
    slices: ["print(1)"],
  });
});

test("an open fence inside a list item stays in its item, plain until it closes", () => {
  expect(md("- step\n  ```sh\n  pnpm i")).toBe("- step\n  ```\n  pnpm i\n  ```");
});

test("a fence opener is held until its newline; a closer in progress is held", () => {
  expect(md("Look:\n```typ")).toBe("Look:\n");
  expect(md("```")).toBe("");
  expect(prepareTail("```ts\na\nb\n``")).toEqual({ kind: "fence", lang: "ts", slices: ["a\nb"] });
  // The closer counts once its newline arrives; then it is plain markdown again.
  expect(prepareTail("```ts\na\n```")).toEqual({ kind: "fence", lang: "ts", slices: ["a"] });
  expect(md("```ts\na\n```\n")).toBe("```ts\na\n```\n");
  // Marks inside a closed fence are code, not emphasis.
  expect(md("```py\nx = a*b\n```\nThen **bold")).toBe("```py\nx = a*b\n```\nThen **bold**");
  expect(md("```py\nx = a_b\n```\nThen _it")).toBe("```py\nx = a_b\n```\nThen _it_");
});

test("unclosed strong emphasis is closed", () => {
  expect(md("This is **x")).toBe("This is **x**");
  expect(md("This is **bold and")).toBe("This is **bold and**");
  // Trailing space stays outside the closer, so the closer still flanks.
  expect(md("This is **bold ")).toBe("This is **bold**");
  expect(md("**a** and **b")).toBe("**a** and **b**");
  expect(md("**a**")).toBe("**a**");
});

test("an inline code span is closed", () => {
  expect(md("Run `pnpm te")).toBe("Run `pnpm te`");
  expect(md("Run `a` and `b")).toBe("Run `a` and `b`");
  // Emphasis marks inside code are not emphasis.
  expect(md("Use `**kwargs")).toBe("Use `**kwargs`");
  expect(md("Use ``a ` b")).toBe("Use ``a ` b``");
});

test("underscores close only when GFM flanking makes them emphasis", () => {
  expect(md("call foo_bar")).toBe("call foo_bar");
  expect(md("call foo_bar and _x")).toBe("call foo_bar and _x_");
  expect(md("snake_case_name")).toBe("snake_case_name");
  expect(md("_one_ and __two")).toBe("_one_ and __two__");
});

test("a lone trailing * or _ is held", () => {
  expect(md("Item a *")).toBe("Item a ");
  expect(md("Bold **")).toBe("Bold ");
  expect(md("word_")).toBe("word");
  expect(md("some _")).toBe("some ");
  // ...unless it closes something.
  expect(md("an *em*")).toBe("an *em*");
});

test("a half link shows its text", () => {
  expect(md("See [the docs](htt")).toBe("See the docs");
  expect(md("See [the docs](")).toBe("See the docs");
  expect(md("See [a](https://a.dev) and [b](ht")).toBe("See [a](https://a.dev) and b");
  expect(md("See [the docs](https://x.dev)")).toBe("See [the docs](https://x.dev)");
});

test("a trailing marker line is held until its newline", () => {
  for (const line of [
    "-",
    "--",
    "=",
    "==",
    "*",
    "***",
    "_",
    "#",
    "##",
    "### ",
    ">",
    "> ",
    "1.",
    "12. ",
    "1)",
    "- ",
    "  -",
    "`",
    "``",
    "```",
    "~",
    "~~",
    "~~~",
    "````",
    "```ts",
  ]) {
    expect(md(`Para\n${line}`), JSON.stringify(line)).toBe("Para\n");
  }
  // With text after the marker it shows.
  expect(md("Para\n- item")).toBe("Para\n- item");
  expect(md("# Ti")).toBe("# Ti");
  // Once its newline arrives it shows.
  expect(md("Para\n---\n")).toBe("Para\n---\n");
});

test("a trailing table row is held until the delimiter row arrives", () => {
  expect(md("Results:\n| a | b |")).toBe("Results:\n");
  expect(md("Results:\n| a | b |\n")).toBe("Results:\n");
  expect(md("Results:\n| a | b |\n| --- | -")).toBe("Results:\n");
  expect(md("Results:\n| a | b |\n| --- | --- |\n")).toBe("Results:\n| a | b |\n| --- | --- |\n");
  expect(md("| a | b |\n| --- | --- |\n| 1 | 2")).toBe("| a | b |\n| --- | --- |\n| 1 | 2");
  // Pipes in prose that a non-pipe line follows show.
  expect(md("x | y\nmore")).toBe("x | y\nmore");
});

test("inline state starts over at a new list item or a blank line", () => {
  expect(md("- **a\n- b")).toBe("- **a\n- b");
  expect(md("**a\n\nb")).toBe("**a\n\nb");
});

// Fix round 1 (review-group-c).
test("prose starting with a backtick or tilde, or holding a pipe, shows (I2)", () => {
  expect(md("`foo` is the function that does the thing")).toBe(
    "`foo` is the function that does the thing",
  );
  expect(md("~5 minutes later the build passed")).toBe("~5 minutes later the build passed");
  expect(md("Use a | b to pipe output somewhere")).toBe("Use a | b to pipe output somewhere");
  // An unclosed code span at a line start closes like any other.
  expect(md("`code")).toBe("`code`");
});

test("a line that really ended in a newline is never held (I2)", () => {
  expect(md("Para\n-")).toBe("Para\n");
  expect(prepareTail("Para\n-", true)).toEqual({ kind: "markdown", source: "Para\n-" });
  // A closed fence counts once the live text has its newline.
  expect(prepareTail("```ts\na\n```", true)).toEqual({ kind: "markdown", source: "```ts\na\n```" });
  // A table header that ended its line still waits for the delimiter row.
  expect(prepareTail("Results:\n| a | b |", true)).toEqual({
    kind: "markdown",
    source: "Results:\n",
  });
  expect(prepareTail("| a |\n| --- |", true)).toEqual({
    kind: "markdown",
    source: "| a |\n| --- |",
  });
});

test("a half link in a long run of brackets is linear (M1)", () => {
  const brackets = "[".repeat(64_000);
  const t0 = performance.now();
  expect(md(brackets)).toBe(brackets);
  expect(md(`${brackets}]`)).toBe(`${brackets}]`);
  expect(md(`${brackets}[a](ht`)).toBe(`${brackets}a`);
  expect(performance.now() - t0).toBeLessThan(100);
});

test("a trailing closer shorter than its opener is held (M2)", () => {
  expect(md("**a*")).toBe("**a**");
  expect(md("__a_")).toBe("__a__");
});

test("indented code and open code spans are left alone (M3)", () => {
  expect(md("    indented code *x")).toBe("    indented code *x");
  expect(md("Para\n\n    code _x")).toBe("Para\n\n    code _x");
  expect(md("Use `[a](b")).toBe("Use `[a](b`");
  // A list item's indented paragraph still closes.
  expect(md("1. a\n\n    **b")).toBe("1. a\n\n    **b**");
});
