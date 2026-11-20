import type { DayUsage } from "@open-factory/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { UsageChart } from "./usage-chart";

function day(date: string, costUsd: number, turns: number): DayUsage {
  return {
    date,
    costUsd,
    turns,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}

/** `n` consecutive days ending on 2026-11-20, each with the given cost. */
function series(n: number, cost = (_i: number) => 1): DayUsage[] {
  const end = Date.UTC(2026, 10, 20);
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return day(date, cost(i), cost(i) > 0 ? 3 : 0);
  });
}

const week = [
  day("2026-11-14", 1, 2),
  day("2026-11-15", 0, 0),
  day("2026-11-16", 0.0001, 1),
  day("2026-11-17", 50, 9),
  day("2026-11-18", 2, 4),
  day("2026-11-19", 3.21, 41),
  day("2026-11-20", 1.5, 1),
];

function renderChart(days = week, rangeDays: 7 | 30 | 90 = 7) {
  return render(
    <UsageChart days={days} rangeDays={rangeDays} timezone="Europe/Berlin" today="2026-11-20" />,
  );
}

afterEach(() => vi.unstubAllGlobals());

/** A ResizeObserver that reports `width` once observing starts. */
function stubWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width } }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

const bars = (c: HTMLElement) => Array.from(c.querySelectorAll<SVGRectElement>("rect[data-bar]"));
const group = () => screen.getByRole("group", { name: /Daily estimated cost/ });
const live = (c: HTMLElement) => c.querySelector('[aria-live="polite"]') as HTMLElement;

test("one bar per day: chart-2, today chart-5, the selected one signal", () => {
  const { container } = renderChart();
  const all = bars(container);
  expect(all).toHaveLength(7);
  expect(all.slice(0, 6).map((b) => b.getAttribute("fill"))).toEqual(
    Array(6).fill("var(--chart-2)"),
  );
  expect(all[6]).toHaveAttribute("fill", "var(--chart-5)");

  fireEvent.keyDown(group(), { key: "Home" });
  expect(bars(container)[0]).toHaveAttribute("fill", "var(--signal)");
  expect(bars(container)[1]).toHaveAttribute("fill", "var(--chart-2)");
});

test("a non-zero tiny value is at least 1 tall; zero is flat", () => {
  const { container } = renderChart();
  const all = bars(container);
  expect(Number(all[2]?.getAttribute("height"))).toBeGreaterThanOrEqual(1);
  expect(Number(all[1]?.getAttribute("height"))).toBe(0);
});

test("the wrapper is the single tab stop with the spelled-out label", () => {
  const { container } = renderChart(series(30), 30);
  const g = group();
  expect(g).toHaveAttribute("tabIndex", "0");
  expect(g).toHaveAttribute(
    "aria-label",
    "Daily estimated cost, last 30 days. Arrow keys move between days.",
  );
  const svg = container.querySelector("svg") as SVGSVGElement;
  expect(svg).toHaveAttribute("aria-hidden", "true");
  expect(svg.querySelectorAll("[tabindex], a, button, input")).toHaveLength(0);
});

test("arrows, Home and End move the selection, Escape clears; the live region mirrors the tooltip", () => {
  const { container } = renderChart();
  const g = group();
  const region = live(container);
  expect(region).toHaveTextContent(/^$/);

  fireEvent.keyDown(g, { key: "End" });
  expect(region).toHaveTextContent("Fri 20 Nov · $1.50 est. · 1 turn · today so far");
  fireEvent.keyDown(g, { key: "ArrowLeft" });
  expect(region).toHaveTextContent(/^Thu 19 Nov · \$3\.21 est\. · 41 turns$/);
  expect(screen.getByTestId("usage-chart-tooltip")).toHaveTextContent(
    /^Thu 19 Nov · \$3\.21 est\. · 41 turns$/,
  );
  fireEvent.keyDown(g, { key: "ArrowRight" });
  expect(region).toHaveTextContent(/today so far$/);
  fireEvent.keyDown(g, { key: "ArrowRight" });
  expect(region).toHaveTextContent(/today so far$/);
  fireEvent.keyDown(g, { key: "Home" });
  expect(region).toHaveTextContent(/^Sat 14 Nov · \$1\.00 est\. · 2 turns$/);
  fireEvent.keyDown(g, { key: "ArrowLeft" });
  expect(region).toHaveTextContent(/^Sat 14 Nov/);
  fireEvent.keyDown(g, { key: "Escape" });
  expect(region).toHaveTextContent(/^$/);
  expect(bars(container).some((b) => b.getAttribute("fill") === "var(--signal)")).toBe(false);
});

test("the hidden table carries every day", () => {
  renderChart();
  const table = screen.getByRole("table");
  expect(table.closest(".sr-only")).not.toBeNull();
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(1 + 7);
  expect(rows[6]).toHaveTextContent("Thu 19 Nov");
  expect(rows[6]).toHaveTextContent("$3.21");
  expect(rows[6]).toHaveTextContent("41");
});

test.each([
  [7, 7],
  [30, 5],
  [90, 7],
] as const)("x labels for %i days: %i of them", (n, labels) => {
  const { container } = renderChart(series(n), n);
  expect(container.querySelectorAll("text[data-x-label]")).toHaveLength(labels);
});

test("the caption names the range and the zone", () => {
  renderChart(series(30), 30);
  expect(screen.getByText("30 days to today, in Europe/Berlin.")).toBeInTheDocument();
});

test("the y axis runs to a nice maximum with three $ gridlines", () => {
  const { container } = renderChart();
  const ticks = Array.from(container.querySelectorAll("text[data-y-label]")).map(
    (t) => t.textContent,
  );
  expect(ticks).toEqual(["$0.00", "$25.00", "$50.00"]);
});

test("a day with no turns reads the same in the tooltip, the live region and the hidden table", () => {
  const { container } = renderChart();
  fireEvent.keyDown(group(), { key: "Home" });
  fireEvent.keyDown(group(), { key: "ArrowRight" }); // 15 Nov, no turns
  expect(live(container)).toHaveTextContent(/^Sun 15 Nov · — · 0 turns$/);
  expect(screen.getByTestId("usage-chart-tooltip")).toHaveTextContent(/^Sun 15 Nov · — · 0 turns$/);
  const row = within(screen.getByRole("table")).getAllByRole("row")[2] as HTMLElement;
  expect(row).toHaveTextContent("Sun 15 Nov—0");
});

test("7-day x labels thin out when the columns are too narrow for them", () => {
  stubWidth(358); // a 390px phone: about 41px per column
  const { container } = renderChart(series(7), 7);
  const labels = Array.from(container.querySelectorAll("text[data-x-label]"));
  expect(labels.map((t) => t.textContent)).toEqual(["14 Nov", "16 Nov", "18 Nov", "20 Nov"]);
});

test("sub-cent maxima keep distinct y labels", () => {
  const { container } = renderChart([day("2026-11-19", 0.002, 1), day("2026-11-20", 0.004, 1)]);
  const ticks = Array.from(container.querySelectorAll("text[data-y-label]")).map(
    (t) => t.textContent,
  );
  expect(ticks).toEqual(["$0.00", "$0.01", "$0.02"]);
});
