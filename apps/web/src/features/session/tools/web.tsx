import { Markdown } from "@/components/markdown/markdown";
import type { ToolRow } from "../rows";
import { OutputTail, TruncatedNote } from "./parts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const input = (row: ToolRow) => (row.call.input ?? {}) as Record<string, unknown>;

/** A URL's host and path, without scheme, query or fragment; the text itself when it doesn't parse. */
function hostPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname === "/" ? "" : u.pathname };
  } catch {
    return { host: url, path: "" };
  }
}

/** WebFetch: host + path (spec §9.2); WebSearch: its query. */
function WebSummary({ row }: { row: ToolRow }) {
  if (row.call.name === "WebSearch")
    return <span className="min-w-0 flex-1 truncate">{str(input(row).query)}</span>;
  const url = str(input(row).url);
  const { host, path } = hostPath(url);
  return (
    <span title={url} className="flex min-w-0 flex-1 items-baseline">
      <span className="min-w-0 shrink-0 truncate">{host}</span>
      <span className="min-w-0 truncate text-muted-foreground">{path}</span>
    </span>
  );
}

/** The prompt, then the result as tool-output markdown (outside content, spec §9.3). A failure
 *  shows its output as text. */
function WebBody({ row }: { row: ToolRow }) {
  const prompt = str(input(row).prompt);
  const result = row.result;
  return (
    <>
      {prompt && (
        <p dir="auto" className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {prompt}
        </p>
      )}
      {result &&
        (row.state === "failed" ? (
          <OutputTail text={result.content} />
        ) : (
          <Markdown source={result.content} variant="work" untrusted />
        ))}
      <TruncatedNote row={row} prefix="result." />
    </>
  );
}

export const webRenderer = { Summary: WebSummary, Body: WebBody };
