import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RowState } from "./row-state";

// The checking row's spinner is drawn by RowState's own render, so its render count is RowState's: a clock whose tick
// state sat in RowState (not in Elapsed) would re-render it every second. (A Profiler can't tell: Elapsed's own
// update also commits inside the row.)
const spinner = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => {
    spinner.renders++;
    return null;
  },
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  ["adding", "Adding…"],
  ["installing", "Installing…"],
  ["checking", "Checking…"],
  ["add_failed", "Couldn't add"],
  ["install_failed", "Install failed"],
  ["missing", "Missing"],
  ["unusable", "Unusable"],
  ["check_failed", "Couldn't check"],
  ["update", "Update available"],
  ["hidden", "Hidden"],
  ["not_pinned", "Not pinned"],
  ["not_installed", "Not installed"],
] as const)("%s reads %s", (state, word) => {
  render(<RowState state={state} />);
  expect(screen.getByText(word)).toBeInTheDocument();
});

test("a pending state shows the server's elapsed time only after 10 seconds", () => {
  vi.setSystemTime(new Date("2026-11-24T10:00:03.000Z"));
  render(<RowState state="checking" since="2026-11-24T10:00:00.000Z" />);
  expect(screen.queryByText(/^\d+s$/)).toBeNull();
  act(() => vi.advanceTimersByTime(7_000));
  expect(screen.getByText("10s")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5_000));
  expect(screen.getByText("15s")).toBeInTheDocument();
});

const counts = { list: 0, sibling: 0 };
function List() {
  counts.list++;
  return (
    <ul>
      <Profiler id="sibling" onRender={() => counts.sibling++}>
        <li>
          <RowState state="missing" />
        </li>
      </Profiler>
      <li>
        <RowState state="checking" since="2026-11-24T10:00:00.000Z" />
      </li>
    </ul>
  );
}

test("the clock's ticks re-render neither the list, a sibling row nor the ticking row itself", () => {
  vi.setSystemTime(new Date("2026-11-24T10:00:03.000Z"));
  counts.list = 0;
  counts.sibling = 0;
  render(<List />);
  const before = { ...counts, drawn: spinner.renders };
  act(() => vi.advanceTimersByTime(12_000));
  expect(screen.getByText("15s")).toBeInTheDocument();
  expect(counts).toEqual({ list: before.list, sibling: before.sibling });
  expect(spinner.renders).toBe(before.drawn);
});

test("a settled state never shows a clock", () => {
  vi.setSystemTime(new Date("2026-11-24T10:05:00.000Z"));
  render(<RowState state="missing" since="2026-11-24T10:00:00.000Z" />);
  expect(screen.queryByText(/^\d/)).toBeNull();
});
