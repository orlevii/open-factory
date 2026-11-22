import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { runInstant } from "@/lib/run-instant";
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

/** The state chip: one word for where the call stands (spec §9.2). */
function chipOf(row: ToolRow): string | null {
  if (row.denial) return "Denied";
  const meta = row.result?.meta;
  if (meta?.tool === "Bash" && meta.interrupted) return "Interrupted";
  return STATE_LABEL[row.state];
}

/** The detail under a collapsed row (`pl-7`, two lines at most): a denial, or a failure's first
 *  error line; never inside the row's toggle. */
function Detail({ row }: { row: ToolRow }) {
  let icon: ReactNode;
  let text: string;
  if (row.denial) {
    icon = <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />;
    text = denialText(row.denial.reason);
  } else if (row.state === "failed" && chipOf(row) === "Failed") {
    icon = <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
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

/** A tool call (spec §9.2): one `min-h-8` line (chevron, the tool's summary, a state chip), a detail
 *  line, and while expanded the tool's body, then its nested rows. */
export function ToolCallRow({
  row,
  expanded,
  onToggle,
  rowProps,
  children,
}: {
  row: ToolRow;
  expanded: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
}) {
  const R = rendererFor(row.call.name);
  const chip = chipOf(row);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          // A keyboard-triggered click (Enter/Space) has detail 0: it toggles without the transition.
          if (e.detail === 0) runInstant(onToggle);
          else onToggle();
        }}
        {...rowProps}
        // `.of-row`: the hover fill and the instant pressed fill; a full-width row never scales.
        // min-h-8, not h-8: at large text sizes the line wraps rather than clips (Break M9).
        className="of-row flex min-h-8 w-full min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm leading-5"
      >
        <ChevronRight
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <R.Summary row={row} />
        </span>
        {chip && <span className="shrink-0 text-[0.8125rem] text-muted-foreground">{chip}</span>}
      </button>
      <Detail row={row} />
      {expanded && (
        <div className="mt-1 space-y-2 pl-6">
          <R.Body row={row} />
          {children && <div className="space-y-3 pl-4">{children}</div>}
        </div>
      )}
    </div>
  );
}
