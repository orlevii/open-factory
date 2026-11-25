import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Elapsed } from "./elapsed";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

test("Elapsed ticks on whole seconds and recomputes when the tab returns", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:00.400Z"));
  render(<Elapsed since="2026-11-21T10:00:00.000Z" />);
  expect(screen.getByText("0s")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByText("1s")).toBeInTheDocument();
  act(() => setHidden(true));
  act(() => vi.advanceTimersByTime(60_000));
  act(() => setHidden(false));
  expect(screen.getByText("1m 01s")).toBeInTheDocument();
});

test("Elapsed does not tick while hidden", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
  render(<Elapsed since="2026-11-21T10:00:00.000Z" />);
  act(() => setHidden(true));
  expect(vi.getTimerCount()).toBe(0);
});

test("Elapsed renders once on mount (no catch-up render) and nothing for an invalid start", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:05.000Z"));
  // Real clocks move between render and effect: every read is a millisecond later.
  let t = Date.now();
  const now = vi.spyOn(Date, "now").mockImplementation(() => t++);
  let renders = 0;
  render(
    <Profiler id="e" onRender={() => renders++}>
      <Elapsed since="2026-11-21T10:00:00.000Z" />
    </Profiler>,
  );
  expect(screen.getByText("5s")).toBeInTheDocument();
  expect(renders).toBe(1);
  now.mockRestore();
  const { container } = render(<Elapsed since="not a date" />);
  expect(container).toBeEmptyDOMElement();
  expect(container.textContent).not.toMatch(/NaN/);
});

test("hideUnderMs shows nothing until then, and the first tick lands at that point", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:03.000Z"));
  const { container } = render(<Elapsed since="2026-11-21T10:00:00.000Z" hideUnderMs={10_000} />);
  expect(container).toBeEmptyDOMElement();
  act(() => vi.advanceTimersByTime(6_999));
  expect(container).toBeEmptyDOMElement();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("10s")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByText("11s")).toBeInTheDocument();
});

test("hideUnderMs shows the time at once for a start already past it", () => {
  vi.setSystemTime(new Date("2026-11-21T10:01:00.000Z"));
  render(<Elapsed since="2026-11-21T10:00:00.000Z" hideUnderMs={10_000} />);
  expect(screen.getByText("1m 00s")).toBeInTheDocument();
});
