import type { AnyEvent } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleX, GitFork, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { TaskBadge } from "@/features/tasks/task-badge";
import { CompactionMarker } from "./compaction-marker";
import { MessageBlock } from "./message-block";
import { OutgoingMessage } from "./outgoing-message";
import { QuietLine } from "./quiet-line";
import type { Row } from "./rows";
import { Actor, SpawnBlock, TerminateLine, terminatedPhrase } from "./spawn-block";
import { resetPhrase } from "./status-badge";
import { ToolCallRow } from "./tool-call-row";
import { PeerLine, UpdateGroup } from "./update-group";

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono">{children}</span>
);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Hibernated after 70 minutes idle" … (S5 UI design §3.3), by the hibernate path's reason. */
function hibernatedText(e: Extract<AnyEvent, { type: "hibernated" }>): string {
  switch (e.reason) {
    case "warm_window":
      return e.idleMinutes === undefined
        ? "Hibernated"
        : `Hibernated after ${plural(e.idleMinutes, "minute", "minutes")} idle`;
    case "freed_slot":
      return "Hibernated to free a slot";
    case "crons_stopped":
      return e.by ? `Hibernated: ${e.by} stopped its crons` : "Hibernated: its crons were stopped";
    case "apply_changes":
      return "Hibernated to apply changes";
    case "shutdown":
      return "Hibernated: the server stopped";
    case "archived":
      return "Stopped: the agent was archived";
    default:
      return "Hibernated";
  }
}

/** The S3 start line, refined by why the process started. */
function startedText(e: Extract<AnyEvent, { type: "process_started" }>): string {
  if (e.reason === "crash_recovery") return "Resumed after a crash";
  if (e.reason === "restart") return "Restarted";
  if (e.reason === "boot_resume") return "Resumed after the server restarted";
  return e.resumed ? "Woke up" : "Started a new session";
}

function lostText(e: Extract<AnyEvent, { type: "background_work_lost" }>): string {
  const items = [
    ...e.tasks.map((t) => `${t.description ?? t.taskId} (background)`),
    ...e.crons.map((c) => `${c.humanSchedule?.toLowerCase() ?? c.cronId} (cron)`),
  ];
  if (e.reason === "crons_stopped") return `Stopped by ${e.by ?? "a human"}: ${items.join(" · ")}`;
  const when = e.reason === "terminated" ? "it was terminated" : "the process stopped";
  return `Lost when ${when}: ${items.join(" · ")}`;
}

/** Quiet-line copy, S3 UI design §4.1 and S5 UI design §3.3. Never pids, container ids, exit codes or
 *  signals: those stay in the expandable detail. */
export function quietText(e: AnyEvent, interrupted = false): ReactNode {
  switch (e.type) {
    case "process_started":
      return startedText(e);
    case "exited":
      return e.expected ? "Stopped" : <span className="text-foreground">Stopped unexpectedly</span>;
    case "session_reset":
      return (
        <>
          New session started by <Mono>{e.by}</Mono>. Earlier history stays above; the agent no
          longer remembers it.
        </>
      );
    case "spawned":
      return (
        <>
          Spawned by <Actor by={e.by} /> from template <Mono>{e.template}</Mono>
        </>
      );
    case "terminated":
      return <>Terminated {terminatedPhrase(e.by)}</>;
    case "control": {
      const by = <Mono>{e.by}</Mono>;
      if (e.cmd === "interrupt") return <>{by} interrupted</>;
      if (e.cmd === "restart") return <>Restarted by {by}</>;
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
      return `Cron created: ${e.humanSchedule.toLowerCase()}${e.durable ? " (kept on disk)" : ""}`;
    case "cron_deleted":
      return "Cron deleted";
    case "hibernated":
      return hibernatedText(e);
    case "container":
      return e.action === "recreated" ? (
        "Container re-created: image or mounts changed"
      ) : (
        <>
          Container created (<Mono>{e.image}</Mono>)
        </>
      );
    case "cleanup":
      return e.container
        ? "Stopped the container to clear leftover processes"
        : `Stopped ${plural(e.killedProcesses ?? 0, "leftover process", "leftover processes")}`;
    case "stop_escalated":
      return "The process didn't stop in time, so it was killed";
    case "background_work_lost":
      return lostText(e);
    case "reconciled":
      return "Cleaned up after the server restarted";
    case "rate_limit_paused":
      return (
        <>
          Rate limit reached on credential <Mono>{e.credential}</Mono>. Paused
          {resetPhrase({ rateLimitedUntil: e.until, rateLimitExact: e.exact })?.joined ?? ""}.
        </>
      );
    case "rate_limit_reset":
      return (
        <>
          Rate limit on credential <Mono>{e.credential}</Mono> reset
        </>
      );
    case "mcp_unavailable":
      return "Factory tools didn't connect in this process, so it can't send messages until it restarts. Messages to it still arrive.";
    default:
      return e.type;
  }
}

/** Expandable detail for quiet lines that carry one (exit code and stderr tail, the raw auto-compact
 *  error). */
function quietDetail(e: AnyEvent): string | undefined {
  if (e.type === "exited" && !e.expected) {
    const how = e.code !== null ? `Exit code ${e.code}` : `Signal ${e.signal ?? "unknown"}`;
    return e.stderrTail ? `${how}\n${e.stderrTail}` : how;
  }
  if (e.type === "compact_failed" && e.trigger === "auto") return e.error;
  if (e.type === "mcp_unavailable") return e.status;
  return undefined;
}

const WARN = new Set([
  "delivery_failed",
  "compact_failed",
  "stop_escalated",
  "background_work_lost",
  "rate_limit_paused",
  "mcp_unavailable",
]);

function quietIcon(e: AnyEvent): ReactNode {
  // One crash is red once: the unexpected exit, never a separate crimson error row.
  if (e.type === "exited" && !e.expected)
    return <CircleAlert aria-hidden="true" className="text-destructive" />;
  if (e.type === "spawned") return <GitFork aria-hidden="true" />;
  if (e.type === "terminated") return <CircleX aria-hidden="true" />;
  return WARN.has(e.type) ? <TriangleAlert aria-hidden="true" /> : undefined;
}

/** Where an error's `fix` points (spec §15, UI design §4.4). */
function FixLink({
  fix,
  slug,
  spawned,
}: {
  fix: NonNullable<Extract<AnyEvent, { type: "error" }>["fix"]>;
  slug: string;
  spawned?: boolean;
}) {
  // A spawned agent can't be edited or re-synced (the server drops these fixes for it, spec §8):
  // never link to an edit page that can only refuse.
  if (spawned && (fix === "edit_agent" || fix === "resync")) return null;
  const cls =
    "text-[0.8125rem] leading-[1.125rem] text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";
  if (fix === "edit_agent")
    return (
      <Link to="/agents/$slug/edit" params={{ slug }} className={cls}>
        Edit the agent
      </Link>
    );
  // Agent details' Runtime says the local runtime is off (S5 UI design §3.2): no link.
  if (fix === "runtime") return null;
  // An unbuilt user image is built in Templates → Images (spec §10.1).
  if (fix === "image")
    return (
      <Link to="/templates" hash="images" className={cls}>
        Open Templates → Images
      </Link>
    );
  // Re-sync lives on the agent's edit page.
  if (fix === "resync")
    return (
      <Link to="/agents/$slug/edit" params={{ slug }} className={cls}>
        Re-sync the agent
      </Link>
    );
  const label = {
    credentials: "Credentials",
    secrets: "Secrets",
    projects: "Projects",
  }[fix];
  return (
    <Link to="/settings" hash={fix} className={cls}>
      Open Settings → {label}
    </Link>
  );
}

export interface TimelineRowProps {
  slug: string;
  /** The session's agent is a spawned one (no edit page). */
  spawned?: boolean;
  row: Row;
  expanded: ReadonlySet<string>;
  toggle(key: string): void;
  rowProps(row: Row): Record<string, unknown>;
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
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
            // `task_assigned` and `task_update` are from the factory; a `task_comment` is from its author.
            system={
              row.message.kind === "system" ||
              row.message.kind === "task_assigned" ||
              row.message.kind === "task_update"
            }
            body={row.message.body}
            urgent={row.message.urgent}
            at={row.at}
            failed={failedIds.has(row.message.id)}
            {...(row.message.kind === "scheduled" && row.message.scheduleKey
              ? {
                  scheduled: {
                    key: row.message.scheduleKey,
                    by: row.message.by,
                    due: row.message.due,
                    late: row.message.late,
                    firings: row.message.firings,
                  },
                }
              : {})}
            badge={
              row.message.taskKey ? (
                <TaskBadge
                  taskKey={row.message.taskKey}
                  title={row.message.taskTitle}
                  link={{
                    comment:
                      row.message.kind === "task_comment" ? row.message.commentId : undefined,
                  }}
                />
              ) : undefined
            }
          />
        </div>
      );
    case "update_group":
      return <UpdateGroup row={row} rowProps={rp} />;
    case "peer":
      return <PeerLine envelope={row.envelope} rowProps={rp} />;
    case "outgoing":
      return (
        <OutgoingMessage
          slug={props.slug}
          row={row}
          showCall={expanded.has(row.key)}
          onToggleCall={() => toggle(row.key)}
          rowProps={rp}
        />
      );
    case "spawn":
      return (
        <SpawnBlock
          slug={props.slug}
          row={row}
          showCall={expanded.has(row.key)}
          onToggleCall={() => toggle(row.key)}
          rowProps={rp}
        />
      );
    case "terminate":
      return <TerminateLine row={row} rowProps={rp} />;
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
          {row.event.fix && (
            <p>
              <FixLink fix={row.event.fix} slug={props.slug} spawned={props.spawned} />
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
        <QuietLine rowProps={rp} icon={quietIcon(row.event)} detail={quietDetail(row.event)}>
          {quietText(row.event, interruptedEnds.has(row.seq))}
        </QuietLine>
      );
  }
}
