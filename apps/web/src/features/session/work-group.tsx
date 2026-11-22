import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { runInstant } from "@/lib/run-instant";
import type { WorkGroupRow } from "./display-passes";
import { formatDuration } from "./format";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Family = "read" | "ran" | "edited" | "other";
const VERB: Record<Family, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  ran: (n) => `ran ${plural(n, "command", "commands")}`,
  edited: (n) => `edited ${plural(n, "file", "files")}`,
  other: (n) => plural(n, "other call", "other calls"),
};

/** The verbs of a finished run, from its flat `verbsKey`: "Read 6 files, ran 4 commands". A run of
 *  nothing but other calls says "3 calls". */
function verbsText(verbsKey: string, callCount: number): string {
  // `verbsKey` is built by `groupWork` from these families only.
  const parts = verbsKey.split(",").map((p) => p.split(":") as [Family, string]);
  // "2 other calls" with nothing else named reads as if something were missing.
  if (parts.length === 1 && parts[0]?.[0] === "other") return plural(callCount, "call", "calls");
  const text = parts.map(([f, n]) => VERB[f](Number(n))).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The header's copy (U3 §9.4): "4 calls so far" while live (the activity line names the tool), else
 *  "Read 6 files, ran 4 commands · 1m 40s". */
export function workGroupText(row: WorkGroupRow): string {
  if (row.live) return `${row.callCount} calls so far`;
  const verbs = verbsText(row.verbsKey, row.callCount);
  return row.durationMs === undefined ? verbs : `${verbs} · ${formatDuration(row.durationMs)}`;
}

/** A folded run of tool calls (U3 §9.4): a `min-h-8` header whose summary wraps (numbers never
 *  truncate) and, while open, the calls, with no height animation. The chevron rotates over 150ms only
 *  when this chevron was clicked; opened any other way (a deep link, an expanded call joining) it
 *  turns at once. */
export function WorkGroup({
  row,
  open,
  onToggle,
  rowProps,
  children,
}: {
  row: WorkGroupRow;
  open: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
}) {
  // The state a pointer click on this chevron asked for: it animates only while the group is in
  // that state, so a later open from anywhere else (a deep link, an expanded call joining) is
  // instant.
  const [clickedTo, setClickedTo] = useState<boolean | null>(null);
  const animate = clickedTo === open;
  const text = workGroupText(row);
  const cut = text.lastIndexOf(" · ");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          // A keyboard-triggered click (Enter/Space) has detail 0: it toggles without the transition.
          setClickedTo(e.detail !== 0 ? !open : null);
          if (e.detail === 0) runInstant(onToggle);
          else onToggle();
        }}
        {...rowProps}
        className="of-row flex min-h-8 w-full min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm leading-5"
      >
        <ChevronRight
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 ${animate ? "transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none" : ""} ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 tabular-nums [overflow-wrap:anywhere]">
          {cut < 0 ? (
            text
          ) : (
            <>
              {text.slice(0, cut)}
              <span className="whitespace-nowrap text-muted-foreground">{text.slice(cut)}</span>
            </>
          )}
        </span>
      </button>
      {open && <div className="mt-2 space-y-2 pl-6">{children}</div>}
    </div>
  );
}
