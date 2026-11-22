import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BlockMarkdown } from "./block-markdown";
import { highlightCache } from "./highlight-cache";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./highlight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./highlight")>()),
  highlight: async (code: string) => {
    calls.push(code);
    return `<pre class="shiki"><code>${code}</code></pre>`;
  },
}));

beforeEach(() => {
  calls.length = 0;
  highlightCache.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** `useId` values differ between mounts; everything else must match. */
const html = (el: Element) => el.innerHTML.replace(/_r_[a-z0-9]+_|«[^»]*»|:r[a-z0-9]+:/gi, "ID");

/** Streams `text` into a live BlockMarkdown in `steps` chunks, lets the throttle settle, and returns
 *  the live DOM next to the persisted rendering of the same text. */
function stream(text: string, steps = 8) {
  const live = render(<BlockMarkdown text="" live />);
  for (let i = 1; i <= steps; i++) {
    const upTo = Math.ceil((text.length * i) / steps);
    live.rerender(<BlockMarkdown text={text.slice(0, upTo)} live />);
    act(() => {
      vi.advanceTimersByTime(40);
    });
  }
  act(() => {
    vi.advanceTimersByTime(300);
  });
  const saved = render(<BlockMarkdown text={text} />);
  return { live: html(live.container), saved: html(saved.container), liveR: live };
}

test("one container holds every block, with no prose wrapper per block", () => {
  const { container } = render(<BlockMarkdown text={"# Title\n\nOne\n\nTwo"} />);
  expect(container.querySelectorAll(".prose-of")).toHaveLength(1);
  expect(container.querySelector(".prose-of")).toHaveClass("prose-of-detail");
  expect(container.querySelectorAll(".prose-of > h1, .prose-of > p")).toHaveLength(3);
  // One shared new-tab note.
  expect(container.querySelectorAll("[hidden]")).toHaveLength(1);
});

test("live and saved renderings of a loose list are the same DOM", () => {
  const r = stream("Steps:\n\n- one\n\n- two\n\n  more two\n\n- three\n\nDone.");
  expect(r.live).toBe(r.saved);
});

test("live and saved renderings of a 6 KB table are the same DOM", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| row ${i} | value ${i} |`).join("\n");
  const text = `| name | value |\n| --- | --- |\n${rows}`;
  expect(text.length).toBeGreaterThan(6000);
  const r = stream(text);
  expect(r.live).toBe(r.saved);
  expect(r.liveR.container.querySelectorAll("table")).toHaveLength(1);
});

test("live and saved renderings of a 6 KB list are the same DOM", () => {
  const text = Array.from({ length: 400 }, (_, i) => `- item number ${i}`).join("\n");
  expect(text.length).toBeGreaterThan(6000);
  const r = stream(text);
  expect(r.live).toBe(r.saved);
  expect(r.liveR.container.querySelectorAll("ul")).toHaveLength(1);
});

test("live and saved renderings of a 64 KB paragraph are the same DOM", () => {
  const text = "word ".repeat(13_000).trim();
  expect(text.length).toBeGreaterThan(64_000);
  const r = stream(text, 20);
  expect(r.live).toBe(r.saved);
  expect(r.liveR.container.querySelectorAll("p")).toHaveLength(1);
});

test("an open block over 4 KB re-parses at most every 250ms", () => {
  const base = "word ".repeat(1000);
  const { container, rerender } = render(<BlockMarkdown text={base} live />);
  const words = () => (container.textContent?.split("word").length ?? 1) - 1;
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(words()).toBe(1000);
  // The first change after a quiet spell shows on the next tick...
  rerender(<BlockMarkdown text={`${base}word `} live />);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(words()).toBe(1001);
  // ...the next one waits out the 250ms since the last parse.
  rerender(<BlockMarkdown text={`${base}word word `} live />);
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(words()).toBe(1001);
  act(() => {
    vi.advanceTimersByTime(150);
  });
  expect(words()).toBe(1002);
});

test("the tail never shows raw syntax: an open fence renders plain code", () => {
  const { container } = render(<BlockMarkdown text={"Look:\n\n```ts\nconst a"} live />);
  expect(container.querySelector("pre > code")).toHaveTextContent("const a");
  expect(container.textContent).not.toContain("```");
  const half = render(<BlockMarkdown text={"This is **bold"} live />);
  expect(half.container.querySelector("strong")).toHaveTextContent("bold");
});

test("a streamed fence calls highlight exactly once, after it closes", async () => {
  const full = "Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.";
  const { container, rerender } = render(<BlockMarkdown text="" live />);
  for (let i = 1; i <= full.length; i++) {
    rerender(<BlockMarkdown text={full.slice(0, i)} live />);
    if (full.slice(0, i).endsWith("```")) expect(calls).toEqual([]);
  }
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  rerender(<BlockMarkdown text={full} />);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(calls).toEqual(["const a = 1;\nconst b = 2;"]);
  expect(container.querySelector("pre.shiki")).toHaveTextContent("const a = 1;");
});
