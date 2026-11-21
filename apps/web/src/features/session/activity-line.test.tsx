import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Elapsed } from "./activity-line";

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
