import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RowState } from "./row-state";

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

test("a pending state shows the server's elapsed time only after 10 seconds, and ticking does not re-render siblings", () => {
  vi.setSystemTime(new Date("2026-11-24T10:00:03.000Z"));
  let siblingRenders = 0;
  render(
    <>
      <Profiler id="sibling" onRender={() => siblingRenders++}>
        <span>sibling</span>
      </Profiler>
      <RowState state="checking" since="2026-11-24T10:00:00.000Z" />
    </>,
  );
  expect(screen.queryByText(/^\d+s$/)).toBeNull();
  act(() => vi.advanceTimersByTime(7_000));
  expect(screen.getByText("10s")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5_000));
  expect(screen.getByText("15s")).toBeInTheDocument();
  expect(siblingRenders).toBe(1);
});

test("a settled state never shows a clock", () => {
  vi.setSystemTime(new Date("2026-11-24T10:05:00.000Z"));
  render(<RowState state="missing" since="2026-11-24T10:00:00.000Z" />);
  expect(screen.queryByText(/^\d/)).toBeNull();
});
