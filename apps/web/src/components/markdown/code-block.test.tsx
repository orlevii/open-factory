import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CodeBlock } from "./code-block";

// Each highlight call parks until the test resolves it, so ordering is under test control.
const pending = vi.hoisted(() => [] as { code: string; resolve: (html: string) => void }[]);
vi.mock("./highlight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./highlight")>()),
  highlight: (code: string) => new Promise<string>((resolve) => pending.push({ code, resolve })),
}));

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
