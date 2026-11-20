import type { AnyEvent } from "@open-factory/shared";
import { CircleAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { CompactionMarker } from "./compaction-marker";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";
import type { Row } from "./rows";
import { ToolCallRow } from "./tool-call-row";

const hhmm = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** Quiet-line copy, UI design §4.1. */
export function quietText(e: AnyEvent, interrupted = false): ReactNode {
  switch (e.type) {
    case "process_started":
      return e.resumed ? "Resumed session" : "Started";
    case "exited":
      if (e.expected) return "Stopped";
      return e.code !== null
        ? `Exited unexpectedly (code ${e.code})`
        : `Exited unexpectedly (${e.signal ?? "unknown"})`;
    case "session_reset":
      return "Session reset";
    case "control": {
      const by = <span className="font-mono">{e.by}</span>;
      if (e.cmd === "interrupt") return <>{by} interrupted</>;
      if (e.cmd === "compact")
        return e.arg ? (
          <>
            {by} asked to compact: {e.arg}
          </>
        ) : (
          <>{by} asked to compact</>
        );
      return <>{by} cleared the session</>;
    }
    case "turn_end":
      return interrupted || e.terminalReason?.startsWith("aborted")
        ? "Turn interrupted"
        : "Turn ended with an error";
    case "delivery_failed":
      return `Not delivered: ${e.reason}. It will be sent again on the next start.`;
    case "compact_failed":
      return e.trigger === "manual" ? `Compact skipped: ${e.error}` : "Auto-compaction skipped";
    case "model_fallback":
      return `Switched to a fallback model: ${e.message}`;
    case "background_task_started":
      return `Background task started: ${e.description ?? e.taskType}`;
    case "background_task_finished":
      return `Background task ${e.status}: ${e.summary}`;
    case "cron_created":
      return `Cron created: ${e.humanSchedule.toLowerCase()}`;
    case "cron_deleted":
      return "Cron deleted";
    case "rate_limited":
      return `Rate limited until ${hhmm(e.resetsAt)}`;
    default:
      return e.type;
  }
}

/** Expandable detail for quiet lines that carry one (stderr tail, the raw auto-compact error). */
function quietDetail(e: AnyEvent): string | undefined {
  if (e.type === "exited" && !e.expected && e.stderrTail) return e.stderrTail;
  if (e.type === "compact_failed" && e.trigger === "auto") return e.error;
  return undefined;
}

const WARN = new Set(["delivery_failed", "compact_failed", "rate_limited"]);

export interface TimelineRowProps {
  row: Row;
  expanded: Set<string>;
  toggle(key: string): void;
  rowProps(row: Row): Record<string, unknown>;
  failedIds: Set<string>;
  interruptedEnds: Set<number>;
}

export function TimelineRow(props: TimelineRowProps) {
  const { row, expanded, toggle, rowProps, failedIds, interruptedEnds } = props;
  const rp = rowProps(row);
  switch (row.kind) {
    case "message":
      return (
        <div {...rp}>
          <MessageBlock
            from={row.message.from}
            body={row.message.body}
            urgent={row.message.urgent}
            at={row.at}
            failed={failedIds.has(row.message.id)}
          />
        </div>
      );
    case "text":
      return (
        <div {...rp}>
          <Markdown source={row.text} />
        </div>
      );
    case "tool":
      return (
        <ToolCallRow
          row={row}
          expanded={expanded.has(row.key)}
          onToggle={() => toggle(row.key)}
          rowProps={rp}
        >
          {row.children.map((c) => (
            <TimelineRow key={c.key} {...props} row={c} />
          ))}
        </ToolCallRow>
      );
    case "orphan_result":
      return <QuietLine rowProps={rp}>Result for an earlier call</QuietLine>;
    case "compaction":
      return <CompactionMarker event={row.event} rowProps={rp} />;
    case "error":
      return (
        <div {...rp} className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            {row.event.message}
          </p>
          {row.event.source === "resume" && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              To start a new session: stop the server, run{" "}
              <code className="font-mono">pnpm seed:dev-agent --reset-session</code>, then start it
              again.
            </p>
          )}
          {row.event.detail && (
            <p className="font-mono text-[0.8125rem] leading-[1.125rem] text-muted-foreground [overflow-wrap:anywhere]">
              {row.event.detail}
            </p>
          )}
        </div>
      );
    case "denied":
      return (
        <QuietLine
          rowProps={rp}
          icon={<ShieldAlert aria-hidden="true" />}
          detail={row.event.reason}
        >
          <span className="flex min-w-0 gap-1.5">
            <span className="shrink-0 text-foreground">Denied: {row.event.toolName}</span>
            <span className="truncate">{row.event.reason}</span>
          </span>
        </QuietLine>
      );
    case "quiet":
      return (
        <QuietLine
          rowProps={rp}
          icon={WARN.has(row.event.type) ? <TriangleAlert aria-hidden="true" /> : undefined}
          detail={quietDetail(row.event)}
        >
          {quietText(row.event, interruptedEnds.has(row.seq))}
        </QuietLine>
      );
  }
}
