import { CodePlate } from "../quiet-line";
import type { ToolRow } from "../rows";
import { McpName } from "./mcp-name";
import { TruncatedNote } from "./parts";

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

/** The tool's name (an identifier, so mono; at most 60% of the line, the full name in its title),
 *  then its one-line summary, muted. */
function GenericSummary({ row }: { row: ToolRow }) {
  const { name, input } = row.call;
  return (
    <>
      <McpName name={name} title={name} className="max-w-[60%] shrink-0 font-mono" />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted-foreground">
        {toolSummary(name, input)}
      </span>
    </>
  );
}

/** Today's body: the input as JSON, then the result, each in a capped plate. */
function GenericBody({ row }: { row: ToolRow }) {
  return (
    <>
      <CodePlate>{JSON.stringify(row.call.input, null, 2)}</CodePlate>
      <TruncatedNote row={row} prefix="input." />
      {row.result && <CodePlate>{row.result.content}</CodePlate>}
      <TruncatedNote row={row} prefix="result." />
    </>
  );
}

/** Unknown tools, and tools whose renderer needs meta a result doesn't carry (spec §9.2). */
export const genericRenderer = { Summary: GenericSummary, Body: GenericBody };
