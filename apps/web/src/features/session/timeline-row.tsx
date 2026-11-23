import type { AnyEvent, SubagentProgress } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleX, GitFork, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { TaskBadge } from "@/features/tasks/task-badge";
import { LocalRuntimeWhy } from "./agent-details";
import { AgentText } from "./agent-text";
import { agentDetailQueryOptions } from "./api";
import { CommandBlock, CommandOutput } from "./command-rows";
import { CompactionMarker } from "./compaction-marker";
import { ConfigChangedLine } from "./config-changed-line";
import { groupOpen } from "./display-passes";
import { formatDuration, formatLastAt } from "./format";
import { MessageBlock } from "./message-block";
import { OutgoingMessage } from "./outgoing-message";
import { QuietLine } from "./quiet-line";
import { NestedRow } from "./row-chrome";
import { isNoticeKind, type Row } from "./rows";
import { Actor, SpawnBlock, TerminateLine, terminatedPhrase } from "./spawn-block";
import { resetPhrase } from "./status-badge";
import { SubagentCard, SubagentOverflow } from "./subagent-card";
import type { RowProgress } from "./timeline-item";
import { ToolCallRow } from "./tool-call-row";
import { PeerLine, UpdateGroup } from "./update-group";
import { WorkGroup } from "./work-group";

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

/** "Worked 2m 13s · 14 tool calls · $0.42 est." (U3 §5.3); zero counts and sub-cent costs are left out. */
export function footerText(row: Extract<Row, { kind: "turn_footer" }>): string {
  const parts: string[] = [];
  if (row.toolCalls) parts.push(`${row.toolCalls} tool call${row.toolCalls === 1 ? "" : "s"}`);
  if (row.costUsd >= 0.01) parts.push(`$${row.costUsd.toFixed(2)} est.`);
  const time = formatDuration(row.durationMs);
  const head = row.origin
    ? `Woke for ${row.origin === "cron" ? "a cron" : "a background task"} · ${time}`
    : `Worked ${time}`;
  return [head, ...parts].join(" · ");
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
    case "interrupt_unconfirmed":
      return "The turn didn't confirm the stop within 10 seconds, so held messages were sent anyway.";
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
  "interrupt_unconfirmed",
]);

function quietIcon(e: AnyEvent): ReactNode {
  // One crash is red once: the unexpected exit, never a separate crimson error row.
  if (e.type === "exited" && !e.expected)
    return <CircleAlert aria-hidden="true" className="text-destructive" />;
  if (e.type === "spawned") return <GitFork aria-hidden="true" />;
  if (e.type === "terminated") return <CircleX aria-hidden="true" />;
  return WARN.has(e.type) ? <TriangleAlert aria-hidden="true" /> : undefined;
}

const FIX_LINK =
  "text-[0.8125rem] leading-[1.125rem] text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/**
 * The agent's template page. The name comes from the session's own cached agent (no extra request once it is
 * loaded); before that, or if it can't be read, the Templates list.
 */
function TemplateLink({ slug, label }: { slug: string; label: (template: string) => string }) {
  const { data: template } = useQuery({
    ...agentDetailQueryOptions(slug),
    staleTime: Number.POSITIVE_INFINITY,
    select: (d) => d.agent.template,
  });
  return template ? (
    <Link to="/templates/$name" params={{ name: template }} className={FIX_LINK}>
      {label(template)}
    </Link>
  ) : (
    <Link to="/templates" className={FIX_LINK}>
      Open Templates
    </Link>
  );
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
  // A spawned agent can't be edited or configured (the server drops these fixes for it, spec §8):
  // never link to an edit page that can only refuse.
  if (spawned && (fix === "edit_agent" || fix === "config")) return null;
  const cls = FIX_LINK;
  // Opens Edit agent over the session (U4 §5.6).
  if (fix === "edit_agent")
    return (
      <button
        type="button"
        className={cls}
        {...sheetIntent("edit-agent", { kind: "edit-agent", slug })}
        onClick={() => openSheet({ kind: "edit-agent", slug })}
      >
        Edit the agent
      </button>
    );
  // Nothing to link to: an operator has to allow the local runtime (S5 UI design §3.2). The row
  // explains how, as Agent details' Runtime row does.
  if (fix === "runtime") return <LocalRuntimeWhy />;
  // An unbuilt user image is built in Templates → Images (spec §10.1).
  if (fix === "image")
    return (
      <Link to="/templates/images" className={cls}>
        Open Templates → Images
      </Link>
    );
  // The agent's own configuration (a plugin that didn't install, an overlay that fails its schema).
  if (fix === "config")
    return (
      <Link to="/agents/$slug/config" params={{ slug }} className={cls}>
        Open configuration
      </Link>
    );
  // A template with errors, or a deleted one, is fixed on its page.
  if (fix === "template") return <TemplateLink slug={slug} label={(t) => `Open template ${t}`} />;
  const target = {
    credentials: { to: "/settings/credentials", label: "Credentials" },
    secrets: { to: "/settings/secrets", label: "Secrets" },
    projects: { to: "/settings/projects", label: "Projects" },
  } as const;
  const { to, label } = target[fix];
  return (
    <Link to={to} className={cls}>
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
  /** Flips a row's key; for a group, `inner` names its calls: closing it collapses them too. */
  toggle(key: string, inner?: readonly string[]): void;
  rowProps(row: Row): Record<string, unknown>;
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
  /** A tool row's time, in its own line on hover or focus (U3 §7.5): a top-level row's or a folded
   *  run's call's, never a tool's nested children's. */
  toolTime?: string;
  /** The row is a folded run's call (`NestedRow`): its time follows its own box's hover and focus. */
  nested?: boolean;
  /** Live progress: a subagent card's entry, or an overflow row's children's (U3 §12). */
  progress?: RowProgress;
}

export function TimelineRow(props: TimelineRowProps) {
  const { row, expanded, toggle, rowProps, failedIds, interruptedEnds } = props;
  // Rows nested under this one never take its progress.
  const inner = { ...props, progress: undefined };
  const rp = rowProps(row);
  switch (row.kind) {
    case "message":
      return (
        <div {...rp}>
          <MessageBlock
            from={row.message.from}
            fromKind={row.message.fromKind}
            // `task_assigned` and `task_update` are from the factory; a `task_comment` is from its author.
            system={isNoticeKind(row.message.kind)}
            body={row.message.body}
            urgent={row.message.urgent}
            at={row.at}
            failed={failedIds.has(row.message.id)}
            attachments={row.message.attachments}
            slug={props.slug}
            {...(row.message.kind === "scheduled" && row.message.scheduleKey
              ? {
                  scheduled: {
                    key: row.message.scheduleKey,
                    by: row.message.by,
                    byKind: row.message.byKind,
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
          <AgentText
            text={row.text}
            live={row.live === true}
            capped={row.capped === true}
            head={row.head}
            at={row.at}
            slug={props.slug}
          />
        </div>
      );
    case "tool":
      return (
        <ToolCallRow
          row={row}
          expanded={expanded.has(row.key)}
          onToggle={() => toggle(row.key)}
          rowProps={rp}
          time={props.toolTime}
          nested={props.nested}
        >
          {row.children.map((c) => (
            <TimelineRow key={c.key} {...inner} toolTime={undefined} nested={false} row={c} />
          ))}
        </ToolCallRow>
      );
    case "subagent":
      return (
        <SubagentCard
          row={row}
          expanded={expanded.has(row.key)}
          onToggle={() => toggle(row.key)}
          rowProps={rp}
          progress={
            Array.isArray(props.progress) ? undefined : (props.progress as SubagentProgress)
          }
        >
          {row.children.map((c) => (
            // Each nested row keeps its own ⋯ and gutter time (U3 §7.5), one plate deep.
            <NestedRow
              key={c.key}
              row={c}
              slug={props.slug}
              focusable={rowProps(c).tabIndex === 0}
              callShown={expanded.has(c.key)}
              onToggleCall={() => toggle(c.key)}
            >
              <TimelineRow
                {...inner}
                row={c}
                toolTime={c.kind === "tool" ? c.at : undefined}
                nested={c.kind === "tool"}
              />
            </NestedRow>
          ))}
        </SubagentCard>
      );
    case "subagent_overflow": {
      const open = groupOpen(row, expanded);
      const list = Array.isArray(props.progress) ? props.progress : undefined;
      return (
        <SubagentOverflow
          count={row.children.length}
          running={row.running}
          open={open}
          onToggle={() =>
            toggle(
              row.key,
              row.children.map((c) => c.key),
            )
          }
          rowProps={rp}
        >
          {open &&
            row.children.map((c, i) => (
              <NestedRow
                key={c.key}
                row={c}
                slug={props.slug}
                focusable={rowProps(c).tabIndex === 0}
                callShown={expanded.has(c.key)}
                onToggleCall={() => toggle(c.key)}
              >
                <TimelineRow {...inner} row={c} progress={list?.[i]} />
              </NestedRow>
            ))}
        </SubagentOverflow>
      );
    }
    case "work_group": {
      const open = groupOpen(row, expanded);
      return (
        <WorkGroup
          row={row}
          open={open}
          onToggle={() =>
            toggle(
              row.key,
              row.children.map((c) => c.key),
            )
          }
          rowProps={rp}
        >
          {open &&
            row.children.map((c) => (
              // Each call keeps its own ⋯ (U3 §7.5) and, like a top-level tool row, its time in its
              // own line; its tab stop is rowProps'.
              <NestedRow
                key={c.key}
                row={c}
                slug={props.slug}
                focusable={rowProps(c).tabIndex === 0}
                callShown={expanded.has(c.key)}
                onToggleCall={() => toggle(c.key)}
              >
                <TimelineRow {...inner} row={c} toolTime={c.at} nested />
              </NestedRow>
            ))}
        </WorkGroup>
      );
    }
    case "orphan_result":
      return <QuietLine rowProps={rp}>Result for an earlier call</QuietLine>;
    case "compaction":
      return <CompactionMarker event={row.event} rowProps={rp} />;
    case "error":
      return (
        <div {...rp} className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            <span className="min-w-0">
              {row.event.message}
              {row.count !== undefined && row.lastAt !== undefined && (
                <span className="text-muted-foreground tabular-nums">
                  {` · ${row.count} times · last ${formatLastAt(new Date(row.lastAt), new Date())}`}
                </span>
              )}
            </span>
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
    case "turn_footer":
      return <QuietLine rowProps={rp}>{footerText(row)}</QuietLine>;
    case "command":
      return (
        <div {...rp}>
          <CommandBlock
            by={row.by}
            fromKind={row.fromKind}
            text={row.text}
            at={row.at}
            pending={row.pending}
          />
        </div>
      );
    case "command_output":
      return <CommandOutput command={row.command} text={row.text} rowProps={rp} />;
    case "quiet":
      if (row.event.type === "config_changed")
        return <ConfigChangedLine by={row.event.by} changes={row.event.changes} rowProps={rp} />;
      return (
        <QuietLine rowProps={rp} icon={quietIcon(row.event)} detail={quietDetail(row.event)}>
          {quietText(row.event, interruptedEnds.has(row.seq))}
        </QuietLine>
      );
  }
}
