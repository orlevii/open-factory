import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Activity } from "./activity";
import { ActivityLine, Elapsed, useFallbackHold } from "./activity-line";

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

const running: Activity = { kind: "tool", tool: "Bash", target: "pnpm test" };
const working: Activity = { kind: "working" };
function Held({ activity, turnKey }: { activity: Activity; turnKey: string }) {
  const shown = useFallbackHold(activity, turnKey);
  return <ActivityLine activity={shown} />;
}
/** Visible text: MiddleTruncate repeats its text for screen readers. */
const visible = (el: Element | null | undefined) => {
  const c = el?.cloneNode(true) as Element | undefined;
  for (const sr of c?.querySelectorAll(".sr-only") ?? []) sr.remove();
  return c?.textContent;
};
const label = () => visible(document.querySelector("[data-activity-label]"));

test("a change to Working holds the previous label 400 ms, never past the turn", () => {
  const { rerender } = render(<Held activity={running} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  rerender(<Held activity={working} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  act(() => vi.advanceTimersByTime(399));
  expect(label()).toBe("Running pnpm test");
  act(() => vi.advanceTimersByTime(1));
  expect(label()).toBe("Working");
  // Any other change is instant, and cuts a hold short.
  rerender(<Held activity={running} turnKey="1" />);
  expect(label()).toBe("Running pnpm test");
  rerender(<Held activity={working} turnKey="1" />);
  rerender(<Held activity={{ kind: "subagent", target: "Draft" }} turnKey="1" />);
  expect(label()).toBe("Subagent: Draft");
  // A new turn never inherits the previous turn's label.
  rerender(<Held activity={working} turnKey="2" />);
  expect(label()).toBe("Working");
  expect(vi.getTimerCount()).toBe(0);
});

test("labels: verbs per tool, subagents, MCP, the PR4 kinds and the fallback", () => {
  const cases: [Activity, string][] = [
    [{ kind: "tool", tool: "Bash", target: "pnpm test" }, "Running pnpm test"],
    [{ kind: "tool", tool: "Read", target: "retry.ts" }, "Reading retry.ts"],
    [{ kind: "tool", tool: "Edit", target: "retry.ts" }, "Editing retry.ts"],
    [{ kind: "tool", tool: "Write", target: "retry.ts" }, "Writing retry.ts"],
    [{ kind: "tool", tool: "Grep", target: "TODO" }, "Searching TODO"],
    [{ kind: "tool_input", tool: "Write", target: "src/app.ts" }, "Writing src/app.ts"],
    [
      { kind: "tool", tool: "mcp__github__create_pr", target: "github · create_pr" },
      "github · create_pr",
    ],
    [{ kind: "tool", tool: "WebFetch" }, "WebFetch"],
    [{ kind: "subagent", target: "Draft the request" }, "Subagent: Draft the request"],
    [{ kind: "subagents", target: "Three", more: 2 }, "Subagents: Three and 2 more"],
    [{ kind: "thinking" }, "Thinking"],
    [{ kind: "text" }, "Writing a reply"],
    [{ kind: "working" }, "Working"],
  ];
  for (const [activity, text] of cases) {
    const { unmount } = render(<ActivityLine activity={activity} />);
    expect(label()).toBe(text);
    expect(document.querySelector("[data-activity-label]")).toHaveAttribute("title", text);
    unmount();
  }
});

test("layout: tooth, duration first, then a truncating label", () => {
  vi.setSystemTime(new Date("2026-11-21T10:00:42.000Z"));
  render(<ActivityLine activity={running} startedAt="2026-11-21T10:00:00.000Z" />);
  const line = document.querySelector("[data-activity-line]") as HTMLElement;
  expect(visible(line)).toBe("42s · Running pnpm test");
  const [tooth, duration] = [...line.children] as HTMLElement[];
  expect(tooth).toHaveAttribute("aria-hidden", "true");
  expect(tooth?.querySelector(".of-tooth")).not.toBeNull();
  expect(duration).toHaveTextContent("42s");
  expect(duration).toHaveClass("tabular-nums", "shrink-0");
  const lbl = line.querySelector("[data-activity-label]") as HTMLElement;
  expect(lbl).toHaveClass("min-w-0");
  expect(line.lastElementChild).toBe(lbl);
  // The target is code.
  expect(within(lbl).getAllByText("pnpm test")[0]?.closest(".font-mono")).not.toBeNull();
});

test("without a start time the duration is omitted", () => {
  render(<ActivityLine activity={working} />);
  expect(visible(document.querySelector("[data-activity-line]"))).toBe("Working");
});
