import type { SubagentProgress } from "@open-factory/shared";
import { ChevronRight } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { runInstant } from "@/lib/run-instant";
import { formatTarget } from "./activity";
import { toolPhrase } from "./activity-line";
import { childrenOf } from "./display-passes";
import { formatDuration, formatTokens } from "./format";
import type { Row, SubagentRow, ToolRow } from "./rows";
import { useSampled } from "./use-sampled";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const CHIP: Record<SubagentRow["state"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  background: "In background",
  stopped: "Stopped",
};

const str = (input: unknown, key: string): string | undefined => {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
};

/** The newest tool call in a transcript (folded runs included): what the live line says it is doing. */
function newestTool(rows: readonly Row[]): ToolRow | undefined {
  let best: ToolRow | undefined;
  const walk = (list: readonly Row[]) => {
    for (const r of list) {
      if (r.kind === "tool" && (!best || r.seq > best.seq)) best = r;
      walk(childrenOf(r));
    }
  };
  walk(rows);
  return best;
}

/** What the subagent answered: the finished background task's summary for an async call (never its
 *  launch notice), else the call's result. */
function resultText(row: SubagentRow): string | undefined {
  if (row.async) return row.summary;
  return row.result?.content || undefined;
}

/** "12 tool calls · 41s · 23k tokens" from persisted figures only; undefined when there are none. */
function figuresText(row: SubagentRow): string | undefined {
  const parts: string[] = [];
  if (row.toolUses !== undefined) parts.push(plural(row.toolUses, "tool call", "tool calls"));
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  if (row.tokens !== undefined) parts.push(`${formatTokens(row.tokens)} tokens`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "4 tool calls · 23k tokens · Reading `x`": counters first, tabular, never a ticking timer, updated
 *  at most twice a second (U3 §12). Memoized on its progress entry, so another card's frame skips it. */
const LiveLine = memo(function LiveLine({
  progress,
  tool,
}: {
  progress: SubagentProgress;
  /** The newest nested call, when the transcript has one: its target beats `lastTool`'s bare name. */
  tool: ToolRow | undefined;
}) {
  const counters = `${plural(progress.toolUses, "tool call", "tool calls")} · ${formatTokens(progress.tokens)} tokens`;
  const name = tool?.call.name ?? progress.lastTool;
  const phrase =
    name === undefined
      ? undefined
      : toolPhrase(name, tool ? formatTarget(tool.call.name, tool.call.input) : undefined);
  const text = useSampled(
    phrase ? `${counters}\u0000${phrase.verb ?? ""}\u0000${phrase.code}` : counters,
  );
  const [count, verb, code] = text.split("\u0000");
  return (
    <p
      data-subagent-live
      className="flex min-w-0 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
    >
      <span className="shrink-0 whitespace-pre tabular-nums">{count}</span>
      {code !== undefined && (
        <span className="min-w-0 truncate whitespace-pre">
          {" · "}
          {verb ? `${verb} ` : ""}
          <span className="font-mono">{code}</span>
        </span>
      )}
    </p>
  );
});

/**
 * An `Agent`/`Task` call (U3 §12, Q19, Q30): a header row ("Subagent · type · description" and a state
 * chip), then, indented behind a 1px neutral rule (no fill, no box), the live line while it runs, the
 * result's first lines once done, and, expanded, the prompt, the transcript and the result last, then
 * the persisted figures. The tool bodies in the transcript are the only plates.
 */
export function SubagentCard({
  row,
  expanded,
  onToggle,
  rowProps,
  progress,
  children,
}: {
  row: SubagentRow;
  expanded: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  progress: SubagentProgress | undefined;
  /** The transcript's rows, rendered by the timeline. */
  children?: ReactNode;
}) {
  const input = row.call.input;
  const type = str(input, "subagent_type") ?? "general-purpose";
  const description = str(input, "description") ?? row.call.name;
  const prompt = str(input, "prompt");
  const chip = row.denial ? "Denied" : CHIP[row.state];
  const busy = row.state === "running" || row.state === "background";
  const result = busy ? undefined : resultText(row);
  const preview = result?.split("\n").slice(0, 3).join("\n");
  const figures = busy ? undefined : figuresText(row);
  return (
    <div data-subagent>
      <button
        type="button"
        aria-expanded={expanded}
        // "in this session": never read as a factory spawn block (U3 §12).
        aria-label={`Subagent in this session · ${type} · ${description} · ${chip}`}
        onClick={(e) => {
          // A keyboard-triggered click (Enter/Space) has detail 0: it toggles without the transition.
          if (e.detail === 0) runInstant(onToggle);
          else onToggle();
        }}
        {...rowProps}
        className="of-row flex min-h-8 w-full min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm leading-5"
      >
        <ChevronRight
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 transition-transform duration-150 ease-(--ease-out) motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
        <span className="flex min-w-0 flex-1 items-baseline">
          <span className="shrink-0 font-medium">
            Subagent<span className="sr-only"> in this session</span>
          </span>
          <span className="shrink-0 whitespace-pre text-muted-foreground"> · </span>
          <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{type}</span>
          <span className="shrink-0 whitespace-pre text-muted-foreground"> · </span>
          <span className="min-w-0 flex-1 truncate">{description}</span>
        </span>
        <span
          data-subagent-chip
          className="flex shrink-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground"
        >
          {row.state === "running" && !row.denial && (
            <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">
              <span className="of-tooth" />
            </span>
          )}
          {chip}
        </span>
      </button>
      <div
        data-subagent-body
        className="mt-1 ml-3 space-y-2 border-l border-border pl-4 empty:hidden"
      >
        {busy && progress && <LiveLine progress={progress} tool={newestTool(row.children)} />}
        {!expanded && preview && (
          <p
            data-subagent-preview
            className="line-clamp-3 text-[0.8125rem] leading-[1.125rem] whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]"
          >
            {preview}
          </p>
        )}
        {expanded && (
          // Its controls belong to the header (`rowOf`): tab order, Esc, focus and scroll anchor.
          <div data-row-body={row.key} className="space-y-3">
            {prompt && <Markdown source={prompt} variant="work" />}
            {children && <div className="space-y-2">{children}</div>}
            {result && <Markdown source={result} variant="work" />}
          </div>
        )}
        {figures && (
          <p
            data-subagent-footer
            className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground tabular-nums"
          >
            {figures}
          </p>
        )}
      </div>
    </div>
  );
}

/** "+2 more subagents · 1 running" (U3 §12, Q40): the 4th and later parallel subagents, expanding in
 *  place below the three cards. */
export function SubagentOverflow({
  count,
  running,
  open,
  onToggle,
  rowProps,
  children,
}: {
  count: number;
  running: number;
  open: boolean;
  onToggle(): void;
  rowProps: Record<string, unknown>;
  children?: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          if (e.detail === 0) runInstant(onToggle);
          else onToggle();
        }}
        {...rowProps}
        className="of-row flex min-h-8 w-full min-w-0 items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm leading-5"
      >
        <ChevronRight
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 tabular-nums [overflow-wrap:anywhere]">
          {`+${plural(count, "more subagent", "more subagents")}`}
          {running > 0 && <span className="text-muted-foreground">{` · ${running} running`}</span>}
        </span>
      </button>
      {open && <div className="mt-2 space-y-2 pl-6">{children}</div>}
    </div>
  );
}
