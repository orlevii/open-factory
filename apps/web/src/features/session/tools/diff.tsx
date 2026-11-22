import type { ToolMeta, ToolMetaHunk } from "@open-factory/shared";
import { Fragment, useMemo, useState } from "react";
import { MiddleTruncate } from "@/components/middle-truncate";
import { CodePlate } from "../quiet-line";
import type { ToolRow } from "../rows";
import { genericRenderer } from "./generic";
import { cleanCode } from "./output";
import { ExpandButton, TruncatedNote } from "./parts";

type DiffMeta = Extract<ToolMeta, { tool: "Edit" | "MultiEdit" | "Write" }>;
type LineKind = "add" | "remove" | "context";
/** One rendered diff line: its gutter number (new; old on − lines), and whether a hunk starts here. */
type DiffLine = { kind: LineKind; n: number; text: string; hunkStart: boolean };

/** Collapsed until the user asks: the first 3 hunks or 80 lines; a create's first 20 (spec §9.2). */
const MAX_HUNKS = 3;
const MAX_LINES = 80;
const CREATE_LINES = 20;

const SIGN: Record<LineKind, string> = { add: "+", remove: "−", context: " " };
/** What a screen reader hears for a changed line; the glyph alone is half-announced. */
const SPOKEN: Record<LineKind, string | null> = { add: "added", remove: "removed", context: null };
/** Tints, not syntax colour: the code stays in ink (Q18). The sticky gutter repeats its line's fill
 *  so code scrolling under it never shows through. */
const FILL: Record<LineKind, string> = {
  add: "bg-diff-add",
  remove: "bg-diff-remove",
  context: "bg-code",
};

function diffMeta(row: ToolRow): DiffMeta | undefined {
  const m = row.result?.meta;
  return m && (m.tool === "Edit" || m.tool === "MultiEdit" || m.tool === "Write") ? m : undefined;
}

const inputStr = (row: ToolRow, key: string) => {
  const v = (row.call.input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
};

const isCreate = (m: DiffMeta) => m.tool === "Write" && m.type === "create";

/** A create's lines come from the call's `content` (its `structuredPatch` is empty, spec §9.1). */
function contentLines(content: string): string[] {
  const body = content.replace(/\n$/, "");
  return body ? body.split("\n") : [];
}

function hunkLines(hunks: ToolMetaHunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    let oldN = h.oldStart;
    let newN = h.newStart;
    let first = true;
    for (const raw of h.lines) {
      const c = raw[0];
      if (c === "\\") continue; // "\ No newline at end of file"
      const text = cleanCode(raw.slice(1));
      const hunkStart = first && out.length > 0;
      first = false;
      if (c === "-") out.push({ kind: "remove", n: oldN++, text, hunkStart });
      else if (c === "+") out.push({ kind: "add", n: newN++, text, hunkStart });
      else {
        out.push({ kind: "context", n: newN, text, hunkStart });
        oldN++;
        newN++;
      }
    }
  }
  return out;
}

/** How many lines show before "Show all": the first 3 hunks, at most 80 lines. */
function collapsedCount(lines: DiffLine[]): number {
  let hunks = 0;
  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    if (i === 0 || lines[i]?.hunkStart) hunks++;
    if (hunks > MAX_HUNKS) return i;
  }
  return Math.min(lines.length, MAX_LINES);
}

/** "Changes to retry.ts": the diff plate's accessible name. */
const changesLabel = (row: ToolRow) => {
  const path = inputStr(row, "file_path");
  return `Changes to ${path.slice(path.lastIndexOf("/") + 1) || "the file"}`;
};

const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

/** Collapsed: the path (middle-truncated, the file name kept) · +4 −2, or "created · 120 lines";
 *  the stat never shrinks. Without meta, today's row. */
function DiffSummary({ row }: { row: ToolRow }) {
  const meta = diffMeta(row);
  const content = inputStr(row, "content");
  const capped = row.truncated?.["input.content"] !== undefined;
  const stat = useMemo(() => {
    if (!meta) return "";
    if (isCreate(meta)) {
      // A capped input holds only the start of the file: its count is a floor.
      const n = contentLines(content).length;
      return capped ? `created · ${n}+ lines` : `created · ${plural(n)}`;
    }
    let add = 0;
    let remove = 0;
    for (const h of meta.hunks)
      for (const l of h.lines) {
        if (l[0] === "+") add++;
        else if (l[0] === "-") remove++;
      }
    return `+${add} −${remove}`;
  }, [meta, content, capped]);
  if (!meta) return <genericRenderer.Summary row={row} />;
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      <span className="flex min-w-0 font-mono text-[0.8125rem]">
        <MiddleTruncate keepEnd text={inputStr(row, "file_path")} />
      </span>
      <span className="shrink-0 whitespace-pre text-muted-foreground"> · </span>
      <span className="shrink-0 font-medium tabular-nums">{stat}</span>
    </span>
  );
}

/** A unified diff in a horizontally scrolling plate: one sticky gutter column (number and sign),
 *  code in ink on add/remove tints, text only (spec §9.2, Q18). */
function DiffLines({
  lines,
  collapsed,
  label,
}: {
  lines: DiffLine[];
  collapsed: number;
  label: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, collapsed);
  // One width for every number, so the code column lines up.
  const gutter = { width: `${String(lines.reduce((m, l) => Math.max(m, l.n), 0)).length}ch` };
  return (
    <div>
      {/* A scrolling region: focusable so the keyboard can scroll it (the timeline's roving
          tabindex keeps it out of the tab order unless its row, found through the body's
          `data-row-body`, is the tab stop), and labelled. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls, not a code region */}
      <div
        data-diff
        role="group"
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        className="mt-1 overflow-x-auto rounded-md border border-code-border bg-code font-mono text-[0.8125rem] leading-[1.125rem]"
      >
        <div className="w-max min-w-full py-1">
          {shown.map((l, i) => (
            // A static list: an index is the line's identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never reorder
            <Fragment key={i}>
              {l.hunkStart && (
                <div
                  aria-hidden="true"
                  className="my-1 border-t border-dashed border-code-border"
                />
              )}
              <div data-diff-line={l.kind} className={`flex ${FILL[l.kind]}`}>
                <span className={`sticky left-0 flex shrink-0 select-none ${FILL[l.kind]}`}>
                  <span
                    data-gutter-number
                    style={gutter}
                    className="box-content pl-2 text-right tabular-nums text-muted-foreground"
                  >
                    {l.n}
                  </span>
                  <span data-sign aria-hidden="true" className="w-[3ch] text-center whitespace-pre">
                    {SIGN[l.kind]}
                  </span>
                </span>
                {SPOKEN[l.kind] && <span className="sr-only">{SPOKEN[l.kind]}</span>}
                <span data-code className="pr-3 whitespace-pre text-foreground">
                  {l.text}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      {!all && shown.length < lines.length && (
        <ExpandButton onExpand={() => setAll(true)}>Show all {plural(lines.length)}</ExpandButton>
      )}
    </div>
  );
}

/** "Diff truncated · show raw output": the harness kept only the hunks that fit (spec §9.1). The
 *  result's own text says only that the file was updated, so the raw view is the call's input (the
 *  strings it replaced or wrote), under the marker, which stays. */
function Truncated({ input }: { input: unknown }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <>
        <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">Diff truncated</p>
        <CodePlate>{JSON.stringify(input, null, 2)}</CodePlate>
      </>
    );
  return (
    <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      Diff truncated · <ExpandButton onExpand={() => setOpen(true)}>show raw output</ExpandButton>
    </p>
  );
}

function DiffView({ row, meta }: { row: ToolRow; meta: DiffMeta }) {
  const create = isCreate(meta);
  const content = create ? inputStr(row, "content") : "";
  const view = useMemo(() => {
    if (!create) {
      const lines = hunkLines(meta.hunks);
      return { lines, collapsed: collapsedCount(lines) };
    }
    const lines = contentLines(content).map(
      (text, i): DiffLine => ({ kind: "add", n: i + 1, text: cleanCode(text), hunkStart: false }),
    );
    return { lines, collapsed: CREATE_LINES };
  }, [create, content, meta]);
  return (
    <>
      {view.lines.length > 0 && (
        <DiffLines lines={view.lines} collapsed={view.collapsed} label={changesLabel(row)} />
      )}
      {meta.partial && <Truncated input={row.call.input} />}
      <TruncatedNote row={row} prefix="input." />
      <TruncatedNote row={row} prefix="result." />
    </>
  );
}

/** Expanded: the diff from the result's hunks, or a create's first lines. Without meta (an older
 *  row, or no result yet), today's body. */
function DiffBody({ row }: { row: ToolRow }) {
  const meta = diffMeta(row);
  return meta ? <DiffView row={row} meta={meta} /> : <genericRenderer.Body row={row} />;
}

export const diffRenderer = { Summary: DiffSummary, Body: DiffBody };
