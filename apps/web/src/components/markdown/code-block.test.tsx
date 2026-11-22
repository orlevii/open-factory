import { act, render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { CodeBlock } from "./code-block";
import { highlightCache } from "./highlight-cache";

// Each highlight call parks until the test resolves it, so ordering is under test control.
const pending = vi.hoisted(() => [] as { code: string; resolve: (html: string) => void }[]);
vi.mock("./highlight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./highlight")>()),
  highlight: (code: string) => new Promise<string>((resolve) => pending.push({ code, resolve })),
}));

beforeEach(() => highlightCache.clear());

const finish = (i: number) =>
  act(async () => pending[i]?.resolve(`<pre class="shiki">${pending[i]?.code}</pre>`));

test("with the language unchanged, keeps the previous highlight while new code highlights, and ignores stale results", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="one" lang="ts" />);
  expect(container.querySelector("pre:not(.shiki)")).toHaveTextContent("one");
  await finish(0);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("one");

  rerender(<CodeBlock code="two" lang="ts" />);
  rerender(<CodeBlock code="three" lang="ts" />);
  // No flash back to plain text while "two" and "three" are in flight.
  expect(container.querySelector("pre.shiki")).toHaveTextContent("one");
  await finish(2);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("three");
  await finish(1); // the stale "two" result arrives late
  expect(container.querySelector("pre.shiki")).toHaveTextContent("three");
});

test("an unknown language renders plain text right away", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="one" lang="ts" />);
  await finish(0);
  rerender(<CodeBlock code="other" lang="nope" />);
  expect(container.querySelector("pre.shiki")).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent("other");
  expect(pending).toHaveLength(1);
});

test("a language change never shows the old language's highlight", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="one" lang="ts" />);
  await finish(0);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("one");

  rerender(<CodeBlock code="two" lang="py" />);
  expect(container.querySelector("pre.shiki")).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent("two");
  await finish(1);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("two");
});

test("a language round trip never resurfaces the old highlight", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="one" lang="ts" />);
  await finish(0);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("one");

  rerender(<CodeBlock code="two" lang="nope" />);
  rerender(<CodeBlock code="two" lang="ts" />);
  expect(container.querySelector("pre.shiki")).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent("two");
  await finish(1);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("two");
});

test("a round trip through a language still in flight shows plain code", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="one" lang="ts" />);
  await finish(0);
  rerender(<CodeBlock code="two" lang="py" />); // in flight, never finished
  rerender(<CodeBlock code="two" lang="ts" />);
  expect(container.querySelector("pre.shiki")).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent("two");
});

test("an open fence renders plain <pre><code> and never highlights; closing it highlights once", async () => {
  pending.length = 0;
  const { container, rerender } = render(<CodeBlock code="const a" lang="ts" closed={false} />);
  expect(container.querySelector("pre > code")).toHaveTextContent("const a");
  rerender(<CodeBlock code="const a = 1" lang="ts" closed={false} />);
  expect(container.querySelector("pre > code")).toHaveTextContent("const a = 1");
  expect(pending).toHaveLength(0);
  rerender(<CodeBlock code="const a = 1" lang="ts" closed />);
  expect(pending).toHaveLength(1);
  await finish(0);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("const a = 1");
  rerender(<CodeBlock code="const a = 1" lang="ts" closed />);
  expect(pending).toHaveLength(1);
});

test("a second mount of a highlighted fence paints highlighted on its first render, with no highlight call", async () => {
  pending.length = 0;
  const first = render(<CodeBlock code="const b = 2" lang="ts" />);
  await finish(0);
  expect(first.container.querySelector("pre.shiki")).toHaveTextContent("const b = 2");
  first.unmount();
  const second = render(<CodeBlock code="const b = 2" lang="ts" />);
  expect(second.container.querySelector("pre.shiki")).toHaveTextContent("const b = 2");
  expect(pending).toHaveLength(1);
  // Code that was highlighted before paints at once when a block changes to it.
  second.rerender(<CodeBlock code="other" lang="ts" />);
  await finish(1);
  second.rerender(<CodeBlock code="const b = 2" lang="ts" />);
  expect(second.container.querySelector("pre.shiki")).toHaveTextContent("const b = 2");
  expect(pending).toHaveLength(2);
});

test("the highlight cache keeps to a byte budget and skips very large code (M6)", () => {
  const big = "x".repeat(20_000);
  highlightCache.set("ts", big, "<pre>big</pre>");
  expect(highlightCache.get("ts", big)).toBeUndefined();
  // ~40 KB per entry: a 4 MB budget holds about a hundred, so the oldest go first.
  const code = (i: number) => `${i}`.padEnd(10_000, "y");
  const htmlOf = "h".repeat(10_000);
  for (let i = 0; i < 150; i++) highlightCache.set("ts", code(i), htmlOf);
  expect(highlightCache.get("ts", code(0))).toBeUndefined();
  expect(highlightCache.get("ts", code(149))).toBe(htmlOf);
  expect(highlightCache.bytes()).toBeLessThanOrEqual(4 * 1024 * 1024);
});
