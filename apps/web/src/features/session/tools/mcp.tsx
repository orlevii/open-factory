import { useMemo } from "react";
import { Markdown } from "@/components/markdown/markdown";
import type { ToolRow } from "../rows";
import { McpName } from "./mcp-name";
import { isBinary } from "./output";
import { OutputPlate, OutputTail, TruncatedNote } from "./parts";

/** The arguments that say what a call is about, first: stored inputs come back in jsonb's key order
 *  (by length), not the agent's, so "first" alone would often pick `base` over `title`. */
const PREFERRED = ["title", "name", "query", "description", "path", "url"];
const rank = (k: string) => {
  const i = PREFERRED.indexOf(k);
  return i < 0 ? PREFERRED.length : i;
};

/** The input's entries, the preferred keys first; the rest keep their order (a stable sort). */
const entriesOf = (input: unknown): [string, unknown][] =>
  input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input).sort(([a], [b]) => rank(a) - rank(b))
    : [];

/** "server · tool" (the server truncates first), then the first string argument, muted (spec §9.2). */
function McpSummary({ row }: { row: ToolRow }) {
  const { name, input } = row.call;
  const first = entriesOf(input).find(([, v]) => typeof v === "string")?.[1] as string | undefined;
  return (
    <>
      <McpName name={name} title={name} className="max-w-[60%] shrink-0 font-mono" />
      {first && (
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
          {first}
        </span>
      )}
    </>
  );
}

/** A JSON result, pretty-printed; undefined when the text isn't a JSON object or array. */
function asJson(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return undefined;
  }
}

/** The input as a key/value list: strings as text, anything else as JSON. */
function InputList({ input }: { input: unknown }) {
  const entries = entriesOf(input);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[0.8125rem] leading-[1.125rem]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate font-mono text-muted-foreground">{k}</dt>
          <dd
            dir="auto"
            className={`line-clamp-6 whitespace-pre-wrap [overflow-wrap:anywhere] ${typeof v === "string" ? "" : "font-mono"}`}
          >
            {typeof v === "string" ? v : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The result: tool-output markdown when it reads as text (outside content, spec §9.3); JSON and
 *  binary output stay text in a plate. */
function McpResult({ content }: { content: string }) {
  const json = useMemo(() => asJson(content), [content]);
  if (json !== undefined) return <OutputPlate>{json}</OutputPlate>;
  if (isBinary(content)) return <OutputTail text={content} />;
  if (!content.trim()) return null;
  return <Markdown source={content} variant="work" untrusted />;
}

/** Expanded: the result first, then the input as a key/value list. A failure shows its output. */
function McpBody({ row }: { row: ToolRow }) {
  const result = row.result;
  return (
    <>
      {result &&
        (row.state === "failed" ? (
          <OutputTail text={result.content} />
        ) : (
          <McpResult content={result.content} />
        ))}
      <TruncatedNote row={row} prefix="result." />
      <InputList input={row.call.input} />
      <TruncatedNote row={row} prefix="input." />
    </>
  );
}

export const mcpRenderer = { Summary: McpSummary, Body: McpBody };
