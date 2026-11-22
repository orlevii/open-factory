import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSampled } from "./use-sampled";

function Probe({ value }: { value: string }) {
  return <span data-probe>{useSampled(value)}</span>;
}
const shown = () => document.querySelector("[data-probe]")?.textContent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a change landing in the same batch as the window's end is shown in the next window (never frozen)", () => {
  const view = render(<Probe value="1" />);
  view.rerender(<Probe value="2" />);
  expect(shown()).toBe("1");
  act(() => {
    vi.advanceTimersByTime(500);
    view.rerender(<Probe value="3" />);
  });
  expect(shown()).toBe("2");
  act(() => vi.advanceTimersByTime(500));
  expect(shown()).toBe("3");
});

test("at most one update per window while the value keeps changing", () => {
  const view = render(<Probe value="0" />);
  const seen = new Set([shown()]);
  for (let i = 1; i <= 20; i++) {
    view.rerender(<Probe value={String(i)} />);
    act(() => vi.advanceTimersByTime(50));
    seen.add(shown());
  }
  expect(seen.size).toBeLessThanOrEqual(3);
  act(() => vi.advanceTimersByTime(500));
  expect(shown()).toBe("20");
});
