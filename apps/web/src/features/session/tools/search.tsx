import { useMemo, useState } from "react";
import type { ToolRow } from "../rows";
import { ExpandButton, OutputTail } from "./parts";

/** At most this many files are kept from a result, with the true count beside them (spec §9.1). */
const MAX_FILES = 200;
/** Shown before "Show all": the first 20 files, or 20 content hits. */
const SHOW = 20;

/** One line of a content search: a match, or a context line (`-A/-B/-C`) shown but never counted. */
export type HitLine = { text: string; match: boolean };

export type SearchResult =
  | { kind: "files"; count: number; files: string[] }
  | { kind: "content"; count: number; groups: { file: string; lines: HitLine[] }[] }
  | { kind: "counts"; count: number; fileCount: number; files: { file: string; n?: number }[] };

export type SearchMode = "files" | "content" | "count";

const FOUND = /^Found (\d+) (?:files?|matches|match|lines?)\b/i;
// Count mode's last line: "Found 12 total occurrences across 3 files."
const FOUND_TOTAL = /^Found (\d+) total occurrences? across (\d+) files?\.?$/i;
const NONE = /^No (?:files|matches) found\.?$/i;
const TRUNCATED_NOTE = /^\(Results are truncated/;
// A content hit's file prefix: a path-like token (a slash or an extension, no spaces) and a colon.
const HIT = /^([^\s:]*\/[^\s:]*|[^\s:/]+\.\w+):(.*)$/;
// A count line: the file, a colon, its number of occurrences.
const COUNT = /^(.+):(\d+)$/;

const NUMBERED_CONTEXT = /-\d+-/g;

/** A context line `<known file>-12-text`: each `-N-` in the line is tried as the end of the file
 *  name, a set lookup each, so the cost follows the line's length, not the number of files. */
function numberedContext(line: string, known: ReadonlySet<string>) {
  for (const m of line.matchAll(NUMBERED_CONTEXT)) {
    const file = line.slice(0, m.index);
    if (known.has(file)) return { file, text: line.slice(file.length + 1) };
  }
  return undefined;
}

/** A context line without line numbers, `<known file>-text`: each dash tried the same way. */
function plainContext(line: string, known: ReadonlySet<string>) {
  for (let i = line.indexOf("-"); i >= 0; i = line.indexOf("-", i + 1)) {
    const file = line.slice(0, i);
    if (known.has(file)) return { file, text: line.slice(i + 1) };
  }
  return undefined;
}

/** Content mode: matches read `path:12:text`, context lines `path-12-text` with `--` between
 *  blocks. A numbered context line of a file seen on a match comes first (its text may hold a
 *  colon); then a match, so `a.ts-old.ts:3:x` stays a match; then an unnumbered context line. */
function parseContent(lines: string[], found: number | undefined): SearchResult {
  const known = new Set<string>();
  for (const line of lines) {
    const m = HIT.exec(line);
    if (m?.[1]) known.add(m[1]);
  }
  const groups: { file: string; lines: HitLine[] }[] = [];
  let count = 0;
  for (const line of lines) {
    if (line === "--") continue; // the separator between context blocks
    const numbered = numberedContext(line, known);
    const hit = numbered ? undefined : HIT.exec(line);
    const ctx = numbered ?? (hit ? undefined : plainContext(line, known));
    const m = ctx ? undefined : hit;
    const file = ctx?.file ?? m?.[1] ?? "";
    const entry = { text: ctx?.text ?? (m ? (m[2] ?? "") : line), match: !ctx };
    if (entry.match) count++;
    const last = groups.at(-1);
    if (last && last.file === file) last.lines.push(entry);
    else groups.push({ file, lines: [entry] });
  }
  return { kind: "content", count: found ?? count, groups };
}

/** Count mode: `path:N` lines and a closing "Found N total occurrences across M files." */
function parseCounts(lines: string[]): SearchResult {
  let total: number | undefined;
  let fileCount: number | undefined;
  const files: { file: string; n?: number }[] = [];
  let sum = 0;
  for (const line of lines) {
    const t = FOUND_TOTAL.exec(line.trim());
    if (t) {
      total = Number(t[1]);
      fileCount = Number(t[2]);
      continue;
    }
    const m = COUNT.exec(line);
    if (m) sum += Number(m[2]);
    if (files.length < MAX_FILES)
      files.push(m ? { file: m[1] ?? "", n: Number(m[2]) } : { file: line });
  }
  return { kind: "counts", count: total ?? sum, fileCount: fileCount ?? files.length, files };
}

/** Grep and Glob results carry no meta: their count and file list come from `content` (spec §9.1).
 *  The count is "Found N files" when the first line says so, else the line count. Any text parses;
 *  unexpected shapes become plain lines. */
export function parseSearch(content: string, mode: SearchMode): SearchResult {
  let lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim() && !TRUNCATED_NOTE.test(l.trim()));
  let found: number | undefined;
  const first = lines[0]?.trim() ?? "";
  if (NONE.test(first)) lines = [];
  else if (mode !== "count") {
    const m = FOUND.exec(first);
    if (m) {
      found = Number(m[1]);
      lines = lines.slice(1);
    }
  }
  if (mode === "count") return parseCounts(lines);
  if (mode === "content") return parseContent(lines, found);
  return { kind: "files", count: found ?? lines.length, files: lines.slice(0, MAX_FILES) };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
function searchInput(row: ToolRow) {
  const i = (row.call.input ?? {}) as Record<string, unknown>;
  return {
    pattern: str(i.pattern),
    path: str(i.path),
    mode: (row.call.name === "Grep" && (i.output_mode === "content" || i.output_mode === "count")
      ? i.output_mode
      : "files") as SearchMode,
  };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function countLabel(r: SearchResult): string {
  if (r.kind === "files") return r.count === 0 ? "no files" : counted(r.count, "file", "files");
  if (r.count === 0) return "no matches";
  const matches = counted(r.count, "match", "matches");
  return r.kind === "counts" ? `${matches} in ${counted(r.fileCount, "file", "files")}` : matches;
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

function CountList({ result }: { result: Extract<SearchResult, { kind: "counts" }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? result.files : result.files.slice(0, SHOW);
  return (
    <div>
      <ul className="space-y-0.5">
        {shown.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list; paths may repeat
          <li key={i} className={ROW}>
            {f.file}
            {f.n !== undefined && <span className="text-muted-foreground"> · {f.n}</span>}
          </li>
        ))}
      </ul>
      {!all && result.files.length > shown.length && (
        <ExpandButton onExpand={() => setAll(true)}>
          Show all {result.files.length} files
        </ExpandButton>
      )}
    </div>
  );
}

/** Content hits under their file; context lines dimmer. The first 20 lines, then "Show all". */
function HitList({ result }: { result: Extract<SearchResult, { kind: "content" }> }) {
  const [all, setAll] = useState(false);
  let budget = all ? Number.POSITIVE_INFINITY : SHOW;
  let total = 0;
  const groups: typeof result.groups = [];
  for (const g of result.groups) {
    total += g.lines.length;
    if (budget <= 0) continue;
    const lines = g.lines.slice(0, budget);
    budget -= lines.length;
    groups.push({ file: g.file, lines });
  }
  const shown = groups.reduce((n, g) => n + g.lines.length, 0);
  return (
    <div className="space-y-1.5">
      {groups.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list; a file may recur
        <div key={i}>
          {g.file && <p className={`${ROW} text-foreground`}>{g.file}</p>}
          {g.lines.map((l, j) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: a static list
              key={j}
              data-context={l.match ? undefined : ""}
              className={`${ROW} ${g.file ? "pl-4" : ""} text-muted-foreground ${l.match ? "" : "opacity-70"}`}
            >
              {l.text}
            </p>
          ))}
        </div>
      ))}
      {!all && total > shown && (
        <ExpandButton onExpand={() => setAll(true)}>
          Show all {counted(result.count, "match", "matches")}
        </ExpandButton>
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
  if (parsed.kind === "files") return <FileList result={parsed} />;
  if (parsed.kind === "counts") return <CountList result={parsed} />;
  return <HitList result={parsed} />;
}

export const searchRenderer = { Summary: SearchSummary, Body: SearchBody };
