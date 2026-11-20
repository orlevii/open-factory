import type { DayUsage, UsageDays } from "@open-factory/shared";
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatCost, formatCostEst, formatDayShort, niceMax } from "./format";

const HEIGHT = 160;
const FALLBACK_WIDTH = 600; // jsdom, and the first paint before ResizeObserver reports
const PAD = { top: 8, right: 24, bottom: 20, left: 48 };
const LABEL_EVERY: Record<UsageDays, number> = { 7: 1, 30: 7, 90: 14 };

function turnsLabel(turns: number): string {
  return `${turns} ${turns === 1 ? "turn" : "turns"}`;
}

/** "Thu 20 Nov · $3.21 est. · 41 turns", today's ending "· today so far". */
function tooltipText(d: DayUsage, today: string): string {
  const cost = formatCostEst(d.costUsd, Math.max(d.turns, 1));
  const parts = [formatDayShort(d.date), cost, turnsLabel(d.turns)];
  if (d.date === today) parts.push("today so far");
  return parts.join(" · ");
}

/** `Thu 20 Nov` → `20 Nov`. */
function axisDay(date: string): string {
  return formatDayShort(date).split(" ").slice(1).join(" ");
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Daily estimated cost as hand-rolled SVG (spec §12.6). The wrapper is the single tab stop;
 * the SVG is decoration for sighted users, and the live region and hidden table carry the same text.
 */
export function UsageChart({
  days,
  rangeDays,
  timezone,
  today,
}: {
  days: DayUsage[];
  rangeDays: UsageDays;
  timezone: string;
  today: string;
}) {
  const [ref, width] = useWidth();
  const [selected, setSelected] = useState<number | null>(null);

  const n = days.length;
  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const colW = n > 0 ? plotW / n : plotW;
  const barW = Math.max(colW * 0.7, 1);
  const max = niceMax(Math.max(0, ...days.map((d) => d.costUsd)));
  const yOf = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const every = LABEL_EVERY[rangeDays];
  const current = selected !== null ? days[selected] : undefined;
  const tip = current ? tooltipText(current, today) : "";

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (n === 0) return;
    const last = n - 1;
    let next: number | null | undefined;
    if (e.key === "ArrowRight") next = selected === null ? 0 : Math.min(selected + 1, last);
    else if (e.key === "ArrowLeft") next = selected === null ? last : Math.max(selected - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") next = null;
    if (next === undefined) return;
    e.preventDefault();
    setSelected(next);
  }

  /** The hit area is the full column: hover selects, a tap selects. */
  function onPointer(e: PointerEvent<HTMLDivElement>) {
    if (n === 0) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.left;
    if (x < 0 || x > plotW) return;
    setSelected(Math.min(Math.floor(x / colW), n - 1));
  }

  const tipX = current && selected !== null ? PAD.left + (selected + 0.5) * colW : 0;
  const tipAlign =
    tipX < width * 0.25 ? "" : tipX > width * 0.75 ? "-translate-x-full" : "-translate-x-1/2";

  return (
    <figure className="m-0 flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a chart, not a form; role="group" names it as one tab stop (spec §12.6). */}
      <div
        ref={ref}
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the wrapper is the chart's single tab stop; arrows move between days.
        tabIndex={0}
        aria-label={`Daily estimated cost, last ${rangeDays} days. Arrow keys move between days.`}
        onKeyDown={onKeyDown}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setSelected(null);
        }}
        onBlur={() => setSelected(null)}
        className="relative w-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ minHeight: HEIGHT }}
      >
        <svg
          aria-hidden="true"
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block tabular-nums"
        >
          {[0, max / 2, max].map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={yOf(v)}
                y2={yOf(v)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                data-y-label=""
                x={PAD.left - 6}
                y={yOf(v)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-xs"
              >
                {formatCost(v, 1)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const h = d.costUsd > 0 ? Math.max((d.costUsd / max) * plotH, 1) : 0;
            const fill =
              i === selected
                ? "var(--signal)"
                : d.date === today
                  ? "var(--chart-5)"
                  : "var(--chart-2)";
            return (
              <rect
                key={d.date}
                data-bar=""
                x={PAD.left + i * colW + (colW - barW) / 2}
                y={PAD.top + plotH - h}
                width={barW}
                height={h}
                fill={fill}
              />
            );
          })}
          {days.map((d, i) =>
            (n - 1 - i) % every === 0 ? (
              <text
                key={d.date}
                data-x-label=""
                x={PAD.left + (i + 0.5) * colW}
                y={HEIGHT - 4}
                textAnchor="middle"
                className="fill-muted-foreground text-xs"
              >
                {axisDay(d.date)}
              </text>
            ) : null,
          )}
        </svg>
        <div
          aria-hidden="true"
          data-testid="usage-chart-tooltip"
          className={cn(
            "pointer-events-none absolute top-0 rounded-sm border bg-popover px-2 py-1 text-popover-foreground text-xs tabular-nums whitespace-nowrap",
            "transition-opacity duration-100 motion-reduce:transition-none",
            tipAlign,
            current ? "opacity-100" : "opacity-0",
          )}
          style={{ left: tipX }}
        >
          {tip}
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {tip}
      </div>
      <div className="sr-only">
        <table>
          <caption>Daily estimated cost</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Cost (est.)</th>
              <th scope="col">Turns</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <th scope="row">{formatDayShort(d.date)}</th>
                <td>{formatCost(d.costUsd, d.turns)}</td>
                <td>{d.turns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="text-muted-foreground text-xs">
        {rangeDays} days to today, in {timezone}.
      </figcaption>
    </figure>
  );
}
