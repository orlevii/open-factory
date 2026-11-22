import { useMemo, useState } from "react";
import type { ToolRow } from "../rows";
import { ExpandButton, OutputTail } from "./parts";

/** At most this many files are kept from a result, with the true count beside them (spec §9.1). */
const MAX_FILES = 200;
/** Shown before "Show all": the first 20 files, or 20 content hits. */
const SHOW = 20;

export type SearchResult =
  | { kind: "files"; count: number; files: string[] }
  | { kind: "content"; count: number; groups: { file: string; hits: string[] }[] };

const FOUND = /^Found (\d+) (?:files?|matches|match|lines?)\b/i;
const NONE = /^No (?:files|matches) found\.?$/i;
const TRUNCATED_NOTE = /^\(Results are truncated/;
// A content hit's file prefix: a path-like token (a slash or an extension, no spaces) and a colon.
const HIT = /^([^\s:]*\/[^\s:]*|[^\s:/]+\.\w+):(.*)$/;

/** Grep and Glob results carry no meta: their count and file list come from `content` (spec §9.1).
 *  The count is "Found N files" when the first line says so, else the line count. Any text parses;
 *  unexpected shapes become plain lines. */
export function parseSearch(content: string, mode: "files" | "content"): SearchResult {
  let lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim() && !TRUNCATED_NOTE.test(l.trim()));
  let found: number | undefined;
  const first = lines[0]?.trim() ?? "";
  if (NONE.test(first)) lines = [];
  else {
    const m = FOUND.exec(first);
    if (m) {
      found = Number(m[1]);
      lines = lines.slice(1);
    }
  }
  if (mode === "files")
    return { kind: "files", count: found ?? lines.length, files: lines.slice(0, MAX_FILES) };
  const groups: { file: string; hits: string[] }[] = [];
  let count = 0;
  for (const line of lines) {
    if (line === "--") continue; // the separator between context blocks
    count++;
    const m = HIT.exec(line);
    const file = m ? (m[1] ?? "") : "";
    const hit = m ? (m[2] ?? "") : line;
    const last = groups.at(-1);
    if (last && last.file === file) last.hits.push(hit);
    else groups.push({ file, hits: [hit] });
  }
  return { kind: "content", count: found ?? count, groups };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
function searchInput(row: ToolRow) {
  const i = (row.call.input ?? {}) as Record<string, unknown>;
  return {
    pattern: str(i.pattern),
    path: str(i.path),
    mode: row.call.name === "Grep" && i.output_mode === "content" ? "content" : "files",
  } as const;
}

function countLabel(r: SearchResult): string {
  const unit = r.kind === "files" ? ["file", "files"] : ["match", "matches"];
  if (r.count === 0) return `no ${unit[1]}`;
  return `${r.count} ${r.count === 1 ? unit[0] : unit[1]}`;
}

function useParsed(row: ToolRow): SearchResult | undefined {
  const { mode } = searchInput(row);
  const content = row.result && row.state !== "failed" ? row.result.content : undefined;
  return useMemo(
    () => (content === undefined ? undefined : parseSearch(content, mode)),
    [content, mode],
  );
}

/** "pattern in path · 6 files" (spec §9.2); the pattern alone while running. */
function SearchSummary({ row }: { row: ToolRow }) {
  const { pattern, path } = searchInput(row);
  const parsed = useParsed(row);
  return (
    <span className="flex min-w-0 flex-1 items-baseline whitespace-pre">
      <span className="min-w-0 truncate font-mono text-[0.8125rem]">{pattern}</span>
      {path && (
        <>
          <span className="shrink-0 text-muted-foreground"> in </span>
          <span className="min-w-0 truncate font-mono text-[0.8125rem]">{path}</span>
        </>
      )}
      {parsed && <span className="shrink-0 text-muted-foreground"> · {countLabel(parsed)}</span>}
    </span>
  );
}

const ROW = "font-mono text-[0.8125rem] leading-[1.125rem] [overflow-wrap:anywhere]";

function FileList({ result }: { result: Extract<SearchResult, { kind: "files" }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? result.files : result.files.slice(0, SHOW);
  const more = result.count - result.files.length;
  return (
    <div>
      <ul className="space-y-0.5">
        {shown.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list; paths may repeat
          <li key={i} className={ROW}>
            {f}
          </li>
        ))}
      </ul>
      {all
        ? more > 0 && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              and {more} more
            </p>
          )
        : result.count > shown.length && (
            <ExpandButton onExpand={() => setAll(true)}>Show all {result.count} files</ExpandButton>
          )}
    </div>
  );
}

function HitList({ result }: { result: Extract<SearchResult, { kind: "content" }> }) {
  const [all, setAll] = useState(false);
  let budget = all ? Number.POSITIVE_INFINITY : SHOW;
  const groups: typeof result.groups = [];
  for (const g of result.groups) {
    if (budget <= 0) break;
    const hits = g.hits.slice(0, budget);
    budget -= hits.length;
    groups.push({ file: g.file, hits });
  }
  const shown = groups.reduce((n, g) => n + g.hits.length, 0);
  return (
    <div className="space-y-1.5">
      {groups.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list; a file may recur
        <div key={i}>
          {g.file && <p className={`${ROW} text-foreground`}>{g.file}</p>}
          {g.hits.map((h, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list
            <p key={j} className={`${ROW} ${g.file ? "pl-4" : ""} text-muted-foreground`}>
              {h}
            </p>
          ))}
        </div>
      ))}
      {!all && result.count > shown && (
        <ExpandButton onExpand={() => setAll(true)}>Show all {result.count} matches</ExpandButton>
      )}
    </div>
  );
}

/** The first 20 files (mono rows), "Show all N files"; content hits grouped by file. A failure shows
 *  its output. */
function SearchBody({ row }: { row: ToolRow }) {
  const parsed = useParsed(row);
  if (row.state === "failed" && row.result) return <OutputTail text={row.result.content} />;
  if (!parsed || parsed.count === 0) return null;
  return parsed.kind === "files" ? <FileList result={parsed} /> : <HitList result={parsed} />;
}

export const searchRenderer = { Summary: SearchSummary, Body: SearchBody };
