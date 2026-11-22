import { type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { formatBytes } from "../format";
import { CodePlate } from "../quiet-line";
import { rowOf } from "../row-of";
import type { ToolRow } from "../rows";
import { byteSize, isBinary, stripAnsi, tailOutput } from "./output";

/** A tool output plate: no height cap of its own, since "Show all" expands in place (spec §9.2);
 *  the 24rem-capped `CodePlate` stays for raw fallbacks. Children are text, never HTML. */
export function OutputPlate({ children }: { children: ReactNode }) {
  return (
    // `data-plate`: it never scrolls (it wraps), so the roving tabindex keeps it out of the tab order.
    <pre
      data-plate
      className="mt-1 rounded-md border border-code-border bg-code p-2 font-mono text-[0.8125rem] leading-[1.125rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {children}
    </pre>
  );
}

/** Focus the row before the clicked control unmounts, so focus never drops to the body. */
const keepRowFocus = (e: MouseEvent<HTMLElement>) =>
  // Without scrolling to it: the row's header can be far above the control (a long diff), and the
  // view must stay where the reader is (U3 §8.1).
  rowOf(e.currentTarget)?.focus({ preventScroll: true });

/** "Show all", "show raw": an in-place expansion. `data-expands` makes the timeline anchor the row
 *  before it grows (§8.1), as `ClampedMarkdown`'s "Show all" does. */
export function ExpandButton({ onExpand, children }: { onExpand(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-expands
      onClick={(e) => {
        keepRowFocus(e);
        onExpand();
      }}
      className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
    >
      {children}
    </button>
  );
}

type OutputView =
  | { binary: true; bytes: number }
  | { binary: false; clean: string; tail: string; total: number; cut: boolean };

/** The end of a tool's output (spec §9.2): the last 12 lines or 2,000 characters with "Show all N
 *  lines" in place, ANSI and control characters stripped, binary output summarized. */
export function OutputTail({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const view = useMemo<OutputView>(() => {
    if (isBinary(text)) return { binary: true, bytes: byteSize(text) };
    const clean = stripAnsi(text).replace(/\n+$/, "");
    return { binary: false, clean, ...tailOutput(clean) };
  }, [text]);
  if (view.binary)
    // "show raw" is the output as it came, unstripped, in the capped plate.
    return all ? (
      <CodePlate>{text}</CodePlate>
    ) : (
      <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        Binary output · {formatBytes(view.bytes)} ·{" "}
        <ExpandButton onExpand={() => setAll(true)}>show raw</ExpandButton>
      </p>
    );
  const cut = view.cut && !all;
  return (
    <div>
      <OutputPlate>{cut ? view.tail : view.clean}</OutputPlate>
      {cut && (
        <ExpandButton onExpand={() => setAll(true)}>
          Show all {view.total} {view.total === 1 ? "line" : "lines"}
        </ExpandButton>
      )}
    </div>
  );
}

/** "Truncated (1.2 MB)" under a capped input or result: capPayload records the capped paths
 *  (input.command, input.new_string, result.content, …). */
export function TruncatedNote({ row, prefix }: { row: ToolRow; prefix: "input." | "result." }) {
  const capped = Object.entries(row.truncated ?? {}).filter(([k]) => k.startsWith(prefix));
  return capped.map(([k, n]) => (
    <p key={k} className="mt-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      {capped.length > 1 ? `Truncated ${k.slice(prefix.length)}` : "Truncated"} ({formatBytes(n)})
    </p>
  ));
}

/** "Show input": the call's input, behind a disclosure, when it adds to the collapsed line. */
export function ShowInput({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline"
      >
        Show input
      </button>
      {open && children}
    </div>
  );
}
