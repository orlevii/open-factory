import type { ToolRow } from "../rows";
import { OutputPlate, OutputTail, ShowInput, TruncatedNote } from "./parts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

function bashInput(input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  return { command: str(i.command), description: str(i.description).trim() };
}

/** Collapsed: the description, then the command muted and truncating on the same line; with no
 *  description, `$ command` (spec §9.2). */
function BashSummary({ row }: { row: ToolRow }) {
  const { command, description } = bashInput(row.call.input);
  if (!description)
    return <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">$ {command}</span>;
  return (
    <>
      <span className="min-w-0 truncate">{description}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted-foreground">
        {command}
      </span>
    </>
  );
}

/** stdout and stderr apart, when the result's `meta.stderr` ends its content (the CLI appends it). */
function splitStderr(row: ToolRow): { output: string; stderr?: string } {
  const content = row.result?.content ?? "";
  const meta = row.result?.meta;
  const stderr = meta?.tool === "Bash" ? meta.stderr : undefined;
  if (!stderr || !content.endsWith(stderr)) return { output: content };
  return { output: content.slice(0, content.length - stderr.length), stderr };
}

/** The command adds to the collapsed line when it is multi-line, long or was capped. */
const commandAdds = (row: ToolRow, command: string, description: string) =>
  command.includes("\n") ||
  command.length > (description ? 40 : 80) ||
  Object.keys(row.truncated ?? {}).some((k) => k.startsWith("input."));

/** Expanded: the output's tail first, stderr in its own plate, then the command behind "Show input"
 *  when it adds something (spec §9.2). Before the result lands, the command itself. */
function BashBody({ row }: { row: ToolRow }) {
  const { command, description } = bashInput(row.call.input);
  const { output, stderr } = splitStderr(row);
  const input = (
    <>
      <OutputPlate>{`$ ${command}`}</OutputPlate>
      <TruncatedNote row={row} prefix="input." />
    </>
  );
  if (!row.result) return input;
  return (
    <>
      {output.trim() ? (
        <OutputTail text={output} />
      ) : (
        !stderr && <p className="text-[0.8125rem] text-muted-foreground">No output</p>
      )}
      {stderr && (
        <div>
          <p className="text-[0.8125rem] leading-[1.125rem] text-destructive/80">stderr</p>
          <OutputTail text={stderr} />
        </div>
      )}
      <TruncatedNote row={row} prefix="result." />
      {commandAdds(row, command, description) && <ShowInput>{input}</ShowInput>}
    </>
  );
}

const TASK_CHIP = {
  running: "In background",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
} as const;

/** A background command's chip lives on its own call row (U3 §9.5). */
const taskChip = (row: ToolRow) =>
  row.backgroundTask ? TASK_CHIP[row.backgroundTask.state] : undefined;

/** Its summary goes on the detail line once it finished or failed. */
const taskDetail = (row: ToolRow) =>
  row.backgroundTask?.state === "running" ? undefined : row.backgroundTask?.summary;

export const bashRenderer = {
  Summary: BashSummary,
  Body: BashBody,
  chip: taskChip,
  detail: taskDetail,
};
