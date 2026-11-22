import type { ToolMeta } from "@open-factory/shared";
import { useEffect, useMemo, useState } from "react";
import { type HighlightToken, highlightFile } from "@/components/markdown/highlight";
import type { ToolRow } from "../rows";
import { ExpandButton, OutputTail } from "./parts";

/** "Show content" shows this much before "Show all", like Bash's tail but from the top (spec §9.2). */
const SHOW_LINES = 12;
const SHOW_CHARS = 2000;

type Line = { n: number | null; text: string };

const filePath = (row: ToolRow) => {
  const v = (row.call.input as Record<string, unknown> | null)?.file_path;
  return typeof v === "string" ? v : "";
};
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

// `     1→text` (current CLI) or `1\ttext` (older): the file's line number, then the line.
const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/;

/** A Read result's lines with the `N→` prefixes taken off into numbers. A `<system-reminder>` block
 *  the CLI appends is dropped; any other unnumbered line is kept without a number. */
export function parseNumbered(content: string): Line[] {
  const out: Line[] = [];
  let reminder = false;
  for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
    const m = NUMBERED.exec(raw);
    if (m && !reminder) {
      out.push({ n: Number(m[1]), text: m[2] ?? "" });
      continue;
    }
    const t = raw.trim();
    if (t.startsWith("<system-reminder>")) reminder = true;
    if (reminder) {
      if (t.endsWith("</system-reminder>")) reminder = false;
      continue;
    }
    out.push({ n: null, text: raw });
  }
  while (out.length > 0 && out.at(-1)?.n === null && !out.at(-1)?.text.trim()) out.pop();
  return out;
}

/** How many lines show before "Show all": 12 lines or 2,000 characters, at least one line. */
function shownCount(lines: Line[]): number {
  let chars = 0;
  for (let i = 0; i < lines.length && i < SHOW_LINES; i++) {
    chars += (lines[i]?.text.length ?? 0) + 1;
    if (chars > SHOW_CHARS) return Math.max(1, i);
  }
  return Math.min(lines.length, SHOW_LINES);
}

const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

type ReadMeta = Extract<ToolMeta, { tool: "Read" | "ReadImage" }>;
function readMeta(row: ToolRow): ReadMeta | undefined {
  const m = row.result?.meta;
  return m && (m.tool === "Read" || m.tool === "ReadImage") ? m : undefined;
}

/** "retry.ts · lines 1–120 of 340", or "screenshot.png · image · 1280×720"; the full path in the
 *  name's title. Without meta (an older row, or still running), the name alone. */
function ReadSummary({ row }: { row: ToolRow }) {
  const path = filePath(row);
  const meta = readMeta(row);
  let detail = "";
  if (meta?.tool === "Read") {
    const end = meta.startLine + Math.max(meta.numLines, 1) - 1;
    detail = `lines ${meta.startLine}–${end} of ${meta.totalLines}`;
  } else if (meta?.tool === "ReadImage")
    detail =
      meta.width !== undefined && meta.height !== undefined
        ? `image · ${meta.width}×${meta.height}`
        : "image";
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      <span title={path} className="min-w-0 truncate font-mono text-[0.8125rem]">
        {fileName(path)}
      </span>
      {detail && <span className="shrink-0 whitespace-pre text-muted-foreground"> · {detail}</span>}
    </span>
  );
}

/** The file's lines with a real gutter (sticky while the plate scrolls sideways), syntax-coloured
 *  by the path's extension when it has a grammar and is short enough; plain until then. */
function FileLines({ lines, path }: { lines: Line[]; path: string }) {
  const [all, setAll] = useState(false);
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null);
  const collapsed = shownCount(lines);
  const shown = all ? lines : lines.slice(0, collapsed);
  // Only the lines on screen are highlighted: "Show all" highlights the rest when asked. Until it
  // lands, the earlier tokens still colour the head (a line's index is the same in both).
  const code = useMemo(
    () => (all ? lines : lines.slice(0, collapsed)).map((l) => l.text).join("\n"),
    [lines, all, collapsed],
  );
  useEffect(() => {
    let live = true;
    highlightFile(code, path)
      .then((t) => live && setTokens(t))
      .catch(() => live && setTokens(null)); // a failed chunk load stays plain
    return () => {
      live = false;
    };
  }, [code, path]);
  const width = { width: `${String(lines.reduce((m, l) => Math.max(m, l.n ?? 0), 0)).length}ch` };
  return (
    <div>
      <div className="mt-1 overflow-x-auto rounded-md border border-code-border bg-code font-mono text-[0.8125rem] leading-[1.125rem]">
        <div className="w-max min-w-full py-1">
          {shown.map((l, i) => (
            // A static list: an index is the line's identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never reorder
            <div key={i} className="flex">
              <span
                data-gutter-number
                aria-hidden="true"
                style={width}
                className="sticky left-0 box-content shrink-0 bg-code pr-3 pl-2 text-right tabular-nums text-muted-foreground select-none"
              >
                {l.n ?? ""}
              </span>
              <span data-code className="shiki pr-3 whitespace-pre text-foreground">
                {tokens?.[i]
                  ? tokens[i].map((t, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder
                      <span key={j} style={t.style}>
                        {t.content}
                      </span>
                    ))
                  : l.text}
              </span>
            </div>
          ))}
        </div>
      </div>
      {!all && shown.length < lines.length && (
        <ExpandButton onExpand={() => setAll(true)}>Show all {plural(lines.length)}</ExpandButton>
      )}
    </div>
  );
}

function ShowContent({ content, path }: { content: string; path: string }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => (open ? parseNumbered(content) : []), [open, content]);
  if (!open) return <ExpandButton onExpand={() => setOpen(true)}>Show content</ExpandButton>;
  if (lines.length === 0) return <p className="text-[0.8125rem] text-muted-foreground">Empty</p>;
  return <FileLines lines={lines} path={path} />;
}

/** Expanded: nothing for an image (it is never stored); for text, "Show content" (spec §9.2). A
 *  failure shows its output. */
function ReadBody({ row }: { row: ToolRow }) {
  const result = row.result;
  if (!result) return null;
  if (row.state === "failed") return <OutputTail text={result.content} />;
  if (readMeta(row)?.tool === "ReadImage") return null;
  return <ShowContent content={result.content} path={filePath(row)} />;
}

export const readRenderer = { Summary: ReadSummary, Body: ReadBody };
