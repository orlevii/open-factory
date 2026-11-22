import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { runInstant } from "@/lib/run-instant";
import { formatBytes, formatTime } from "./format";
import { CodePlate } from "./quiet-line";
import type { Row } from "./rows";

/** One-line summary: Bash → command, Read/Edit/Write → file path, Grep/Glob → pattern, else the first string. */
export const toolSummary = (name: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof i.command === "string") return i.command;
  for (const k of ["file_path", "path", "pattern", "url", "description"]) {
    const v = i[k];
    if (typeof v === "string") return v;
  }
  const first = Object.values(i).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
};

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

export function ToolCallRow({
  row,
  expanded,
  onToggle,
  rowProps,
  children,
  time,
}: {
  row: Extract<Row, { kind: "tool" }>;
  expanded: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
  /** A top-level row's time, shown at the line's end on hover or focus (U3 §7.5): content | time | ⋯,
   *  in the line itself, so it never covers the state. */
  time?: string;
}) {
  const summary = toolSummary(row.call.name, row.call.input);
  const state = row.denial ? "Denied" : STATE_LABEL[row.state];
  // capPayload records the capped path (input.command, input.new_string, result.content, …).
  const truncatedNote = (prefix: "input." | "result.") => {
    const capped = Object.entries(row.truncated ?? {}).filter(([k]) => k.startsWith(prefix));
    return capped.map(([k, n]) => (
      <p key={k} className="mt-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {capped.length > 1 ? `Truncated ${k.slice(prefix.length)}` : "Truncated"} ({formatBytes(n)})
      </p>
    ));
  };
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
        className="of-row flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-sm"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-4 shrink-0 transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-mono">{row.call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted-foreground">
          {summary}
        </span>
        {state && (
          <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] text-muted-foreground">
            {row.denial ? (
              <TriangleAlert aria-hidden="true" className="size-3.5 text-warning" />
            ) : (
              row.state === "failed" && (
                <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />
              )
            )}
            {state}
          </span>
        )}
        {time !== undefined && (
          <time
            data-gutter-time
            // Not part of the row's name: the title carries it, and on touch the row menu.
            aria-hidden="true"
            dateTime={time}
            title={new Date(time).toLocaleString()}
            className="hidden shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums group-focus-within:inline group-hover:inline pointer-coarse:hidden!"
          >
            {formatTime(time)}
          </time>
        )}
      </button>
      {row.denial && (
        <p className="flex items-start gap-1.5 pl-7 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{denialText(row.denial.reason)}</span>
        </p>
      )}
      {expanded && (
        <div className="mt-1 space-y-2 pl-6">
          <CodePlate>
            {row.call.name === "Bash" ? summary : JSON.stringify(row.call.input, null, 2)}
          </CodePlate>
          {truncatedNote("input.")}
          {row.result && <CodePlate>{row.result.content}</CodePlate>}
          {truncatedNote("result.")}
          {children && <div className="space-y-3 pl-4">{children}</div>}
        </div>
      )}
    </div>
  );
}
