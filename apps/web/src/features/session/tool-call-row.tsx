import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { runInstant } from "@/lib/run-instant";
import { formatTime } from "./format";
import { useLongPressRegion } from "./long-press-region";
import type { ToolRow } from "./rows";
import { rendererFor } from "./tools";
import { firstLine } from "./tools/output";

export { toolSummary } from "./tools/generic";

const RULE_DENIAL = "Denied by a permission rule";

/** The line under a denied call's summary: the reason when there is one (UI design §4.4). */
export const denialText = (reason: string) => {
  const r = reason.trim();
  return r && r !== RULE_DENIAL ? `Denied: ${r}` : RULE_DENIAL;
};

const STATE_LABEL = {
  running: "Running",
  no_result: "No result",
  failed: "Failed",
  done: null,
} as const;

const TASK_CHIP = {
  running: "In background",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
} as const;

/** The state chip: one word for where the call stands (spec §9.2). A background task the call
 *  started speaks for it, whatever the tool (U3 §9.5). */
function chipOf(row: ToolRow): string | null {
  if (row.denial) return "Denied";
  if (row.backgroundTask) return TASK_CHIP[row.backgroundTask.state];
  if (row.interrupted) return "Interrupted";
  const meta = row.result?.meta;
  if (meta?.tool === "Bash" && meta.interrupted) return "Interrupted";
  return STATE_LABEL[row.state];
}

const failedIcon = (
  <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
);

/** The detail under a collapsed row (`pl-7`, two lines at most): a denial, a settled background
 *  task's summary (U3 §9.5), or a failure's first error line; never inside the row's toggle. */
function Detail({ row, chip }: { row: ToolRow; chip: string | null }) {
  let icon: ReactNode;
  let text: string;
  const task = row.backgroundTask;
  const own = task && task.state !== "running" ? task.summary : undefined;
  if (row.denial) {
    icon = <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />;
    text = denialText(row.denial.reason);
  } else if (own) {
    if (chip === "Failed") icon = failedIcon;
    text = own;
  } else if (row.state === "failed" && chip === "Failed") {
    icon = failedIcon;
    text = firstLine(row.result?.content ?? "");
    if (!text) return null;
  } else return null;
  return (
    <p className="flex items-start gap-1.5 pl-7 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      {icon}
      <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

// Shown on hover or focus within the row's own box: the timeline item's `group`, or a folded run's
// call's `group/call` (so hovering one call never shows its siblings' time).
const TIME_SHOWN = {
  top: "group-focus-within:inline group-hover:inline",
  nested: "group-focus-within/call:inline group-hover/call:inline",
} as const;

/** A tool call (spec §9.2): one `min-h-8` line (chevron, the tool's summary, a state chip), a detail
 *  line, and while expanded the tool's body, then its nested rows. */
export function ToolCallRow({
  row,
  expanded,
  onToggle,
  rowProps,
  children,
  time,
  nested = false,
}: {
  row: ToolRow;
  expanded: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
  /** The row's time, shown at the line's end on hover or focus (U3 §7.5): content | time | ⋯,
   *  in the line itself, so it never covers the state. */
  time?: string;
  /** A folded run's call (`NestedRow`): its time shows on its own box's hover and focus only. */
  nested?: boolean;
}) {
  const R = rendererFor(row.call.name);
  // The summary line: on a timeline row, a long-press opens the row's menu (U4 §11.2).
  const region = useLongPressRegion();
  const chip = chipOf(row);
  // Nothing to show (an image read): a plain row, no chevron, no expanded state.
  const expandable = R.hasBody?.(row) !== false || Boolean(children);
  return (
    <div>
      <button
        type="button"
        {...(expandable ? { "aria-expanded": expanded } : {})}
        onClick={(e) => {
          if (!expandable) return;
          // A keyboard-triggered click (Enter/Space) has detail 0: it toggles without the transition.
          if (e.detail === 0) runInstant(onToggle);
          else onToggle();
        }}
        {...rowProps}
        {...region}
        // `.of-row`: the hover fill and the instant pressed fill; a full-width row never scales.
        // min-h-8, not h-8: at large text sizes the line wraps rather than clips (Break M9).
        className="of-row flex min-h-8 w-full min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm leading-5"
      >
        {expandable ? (
          <ChevronRight
            aria-hidden="true"
            className={`mt-0.5 size-4 shrink-0 transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          />
        ) : (
          // The chevron's width stays, so the summary lines up with its neighbours'.
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <R.Summary row={row} />
        </span>
        {chip && <span className="shrink-0 text-[0.8125rem] text-muted-foreground">{chip}</span>}
        {time !== undefined && (
          <time
            data-gutter-time
            // Not part of the row's name: the title carries it, and on touch the row menu.
            aria-hidden="true"
            dateTime={time}
            title={new Date(time).toLocaleString()}
            className={`hidden shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums ${nested ? TIME_SHOWN.nested : TIME_SHOWN.top} pointer-coarse:hidden!`}
          >
            {formatTime(time)}
          </time>
        )}
      </button>
      <Detail row={row} chip={chip} />
      {expanded && expandable && (
        // Its controls belong to the row above (`rowOf`): tab order, Esc, focus and scroll anchor.
        <div data-row-body={row.key} className="mt-1 space-y-2 pl-6">
          <R.Body row={row} />
          {children && <div className="space-y-3 pl-4">{children}</div>}
        </div>
      )}
    </div>
  );
}
