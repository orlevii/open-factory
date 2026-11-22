import type { AnyEvent } from "@open-factory/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderInRouter } from "@/test/render-in-router";
import type { Row } from "./rows";
import { Timeline } from "./timeline";

const at = "2026-11-21T10:00:00.000Z";
const text = (seq: number): Row => ({
  kind: "text",
  seq,
  at,
  text: `Text ${seq}`,
  key: `${seq}`,
  head: false,
});
const tool = (seq: number, children: Row[] = []): Row => ({
  kind: "tool",
  seq,
  at,
  call: { type: "tool_call", toolUseId: `t${seq}`, name: "Task", input: { description: "scan" } },
  state: "done",
  children,
  key: `${seq}`,
});
const failure: Extract<AnyEvent, { type: "error" }> = {
  type: "error",
  source: "spawn",
  code: "image_not_built",
  message: "Image isn't built",
};
const merged: Row = {
  kind: "error",
  seq: 4,
  at,
  event: failure,
  key: "4",
  count: 3,
  lastAt: at,
  seqs: [4, 5, 6],
};

const rowEl = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);

function show(rows: Row[], highlightSeq: number) {
  return renderInRouter(
    <Timeline
      slug="dev"
      rows={rows}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      highlightSeq={highlightSeq}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
}

let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("?event= focuses the row: it becomes the tab stop, with no tabindex -1", async () => {
  show([text(1), text(2), text(3)], 2);
  await screen.findByText("Text 2");
  const row = rowEl("2") as HTMLElement;
  expect(row).toHaveFocus();
  expect(row).toHaveAttribute("tabindex", "0");
  expect(rowEl("1")).toHaveAttribute("tabindex", "-1");
});

test("the tint sits on the row's own box, not the wrap", async () => {
  show([text(1), text(2)], 2);
  await screen.findByText("Text 2");
  const row = rowEl("2") as HTMLElement;
  expect(row).toHaveAttribute("data-arrived");
  expect(row.closest("[data-row-wrap]")).not.toHaveAttribute("data-arrived");
  expect(document.querySelectorAll("[data-arrived]")).toHaveLength(1);
});

test("data-focus-ring stands in where :focus-visible doesn't match, until blur", async () => {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, s: string) {
    return s === ":focus-visible" ? false : matches.call(this, s);
  });
  show([text(1), text(2)], 2);
  await screen.findByText("Text 2");
  const row = rowEl("2") as HTMLElement;
  expect(row).toHaveAttribute("data-focus-ring");
  act(() => row.blur());
  expect(row).not.toHaveAttribute("data-focus-ring");
});

test("no data-focus-ring when :focus-visible matches (keyboard navigation)", async () => {
  show([text(1), text(2)], 2);
  await screen.findByText("Text 2");
  expect(rowEl("2")).not.toHaveAttribute("data-focus-ring");
});

test("after 2s of visible time the tint fades, and the attribute goes on transitionend", async () => {
  vi.useFakeTimers();
  show([text(1), text(2)], 2);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const row = rowEl("2") as HTMLElement;
  expect(row).toHaveAttribute("data-arrived", "");
  await act(() => vi.advanceTimersByTimeAsync(1999));
  expect(row).toHaveAttribute("data-arrived", "");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(row).toHaveAttribute("data-arrived", "fading");
  fireEvent.transitionEnd(row, { propertyName: "opacity" });
  expect(row).not.toHaveAttribute("data-arrived");
});

test("the timer only counts visible time: hidden, it makes no progress", async () => {
  vi.useFakeTimers();
  show([text(1), text(2)], 2);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const row = rowEl("2") as HTMLElement;
  await act(() => vi.advanceTimersByTimeAsync(1500));
  hidden = true;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(row).toHaveAttribute("data-arrived", "");
  hidden = false;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(row).toHaveAttribute("data-arrived", "");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(row).toHaveAttribute("data-arrived", "fading");
});

test("the tint no longer clears on a click elsewhere", async () => {
  show([text(1), text(2)], 2);
  await screen.findByText("Text 2");
  fireEvent.pointerDown(screen.getByText("Text 1"));
  expect(rowEl("2")).toHaveAttribute("data-arrived");
});

test("a link into a tool's children expands the holder and lands on the child", async () => {
  show([text(1), tool(2, [text(3), text(9)])], 9);
  await vi.waitFor(() => expect(rowEl("9")).toHaveFocus());
  const child = rowEl("9") as HTMLElement;
  expect(rowEl("2")).toHaveAttribute("aria-expanded", "true");
  expect(child).toHaveAttribute("data-arrived");
  expect(child).toHaveAttribute("tabindex", "0");
});

test("a link into a merged failure lands on it", async () => {
  show([text(1), merged, text(7)], 5);
  await screen.findByText(/Image isn't built/);
  const row = rowEl("4") as HTMLElement;
  expect(row).toHaveFocus();
  expect(row).toHaveAttribute("data-arrived");
});
