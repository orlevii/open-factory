import { ChevronRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "./format";
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
}: {
  row: Extract<Row, { kind: "tool" }>;
  expanded: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
}) {
  const summary = toolSummary(row.call.name, row.call.input);
  const state = STATE_LABEL[row.state];
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
        onClick={onToggle}
        {...rowProps}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-sm hover:bg-accent"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-4 shrink-0 ${expanded ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-mono">{row.call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted-foreground">
          {summary}
        </span>
        {state && (
          <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] text-muted-foreground">
            {row.state === "failed" && (
              <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />
            )}
            {state}
          </span>
        )}
      </button>
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
