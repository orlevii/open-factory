import type { AgentSummary, AgentUsageRow } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCw, X } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { AgentChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { schedulesListOptions } from "@/features/schedules/api";
import { ScheduleTime } from "@/features/schedules/schedule-time";
import { agentTasksOptions } from "@/features/tasks/api";
import { STATUS } from "@/features/tasks/status-label";
import { formatCost } from "@/features/usage/format";
import { agentsListQueryOptions } from "./api";
import { CronsSegment } from "./crons-popover";
import { formatTime } from "./format";
import { LINK_CLASS } from "./message-block";
import { resetPhrase } from "./status-badge";
import type { StopCrons } from "./stop-crons";
import { endedSentence, PinToggle, WhatsKept, workspaceSentence } from "./terminated-strip";

export const RESTART_WHY =
  "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Its crons from this session stop, and it's told which, so it can recreate them.";

const MAX_REPORTS = 8;
const MAX_WORK = 5;
/** Past this many characters a description is likely to need the 3-line clamp; jsdom has no layout, so this is a length guess. */
const CLAMP_CHARS = 140;

const waitingText = (n: number) =>
  n > 0 ? ` (waiting on ${n} background ${n === 1 ? "task" : "tasks"})` : "";

/** A "Why?" ghost button with its explanation in a popover; `label` is its distinct accessible name. */
export function Why({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={label}>
          Why?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
        <p>{children}</p>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-b border-border px-4 py-3 text-[0.8125rem] leading-[1.125rem]">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clampable = text.length > CLAMP_CHARS;
  return (
    <div className="grid justify-items-start gap-1">
      <p className={`text-muted-foreground whitespace-pre-line ${open ? "" : "line-clamp-3"}`}>
        {text}
      </p>
      {clampable && (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-ml-2"
        >
          {open ? "Less" : "More"}
        </Button>
      )}
    </div>
  );
}

/** Why messages aren't going out right now (the header's wording, in full). */
function detailText(agent: AgentSummary, slotsMax?: number): ReactNode {
  if (agent.pulling) return "Pulling the image…";
  if (agent.status === "queued" && slotsMax)
    return slotsMax === 1
      ? "Queued: the only slot is in use."
      : `Queued: all ${slotsMax} slots are in use.`;
  if (agent.status === "rate_limited")
    return (
      <>
        Paused: credential <span className="font-mono">{agent.credential}</span> is rate-limited
        {resetPhrase(agent)?.joined ?? ""}. Messages wait until then.
      </>
    );
  return null;
}

function Now({
  agent,
  stop,
  slotsMax,
  onAgent,
}: {
  agent: AgentSummary;
  stop: StopCrons;
  slotsMax?: number;
  onAgent?: (a: AgentSummary) => void;
}) {
  const terminated = agent.status === "terminated" || !!agent.terminatedAt;
  const rows: { key: string; node: ReactNode }[] = [];
  if (terminated) {
    const now = new Date();
    const workspace = workspaceSentence(agent, now);
    const stuck = agent.stuck
      ? " Its container couldn't be removed; the factory keeps retrying."
      : "";
    const canPin =
      !agent.workspaceDeletedAt && (agent.workspacePinned || !!agent.workspaceGraceEndsAt);
    rows.push({
      key: "terminated",
      node: (
        <div className="flex flex-wrap items-center gap-x-2">
          <span>
            {endedSentence(agent, now)}
            {`${workspace ? ` ${workspace}` : ""}${stuck}`}
          </span>
          {canPin && <PinToggle agent={agent} onAgent={onAgent} />}
          <WhatsKept />
        </div>
      ),
    });
  } else {
    if (agent.status === "errored" && agent.lastError)
      rows.push({
        key: "error",
        node: <span className="whitespace-pre-line text-destructive">{agent.lastError}</span>,
      });
    const detail = detailText(agent, slotsMax);
    if (detail) rows.push({ key: "detail", node: <span>{detail}</span> });
    if (agent.restartPending)
      rows.push({
        key: "restart",
        node: (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
            Restarts when idle to apply changes{waitingText(agent.restartWaitingOn)}
            <Why label="Why does it restart?">{RESTART_WHY}</Why>
          </span>
        ),
      });
    for (const t of agent.waitingOn.tasks)
      rows.push({
        key: t.taskId,
        node: (
          <span>
            {t.description || t.taskId} (background) · since {formatTime(t.startedAt)}
          </span>
        ),
      });
    if (agent.waitingOn.crons > 0)
      rows.push({
        key: "crons",
        node: (
          <span>
            Kept awake by <CronsSegment agent={agent} stop={stop} />
          </span>
        ),
      });
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Now">
      {rows.map((r) => (
        <div key={r.key}>{r.node}</div>
      ))}
    </Section>
  );
}

function Org({ agent }: { agent: AgentSummary }) {
  const slug = agent.slug;
  const select = useCallback((l: AgentSummary[]) => l.filter((a) => a.reportsTo === slug), [slug]);
  // A cache read for the reports shown; the list is the sidebar's, never fetched from here.
  const reports = useQuery({
    ...agentsListQueryOptions("exclude"),
    refetchOnMount: false,
    select,
  }).data;
  const shown = reports?.slice(0, MAX_REPORTS) ?? [];
  return (
    <Section title="Org">
      <div className="flex flex-wrap items-center gap-x-2 @container">
        <span className="text-muted-foreground">
          {agent.kind === "ephemeral" ? "Spawned by" : "Reports to"}
        </span>
        {agent.reportsTo ? (
          <AgentChip slug={agent.reportsTo} link size={16} />
        ) : (
          <span>No manager</span>
        )}
      </div>
      {agent.reports > 0 && (
        <ul className="grid gap-1.5 @container">
          {shown.map((r) => (
            <li key={r.slug} className="flex min-w-0">
              <AgentChip agent={r} link size={16} badge />
            </li>
          ))}
        </ul>
      )}
      {agent.reports > MAX_REPORTS && (
        <Link to="/agents" search={{ focus: slug }} className={`justify-self-start ${LINK_CLASS}`}>
          All {agent.reports} reports
        </Link>
      )}
    </Section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Work({ agent }: { agent: AgentSummary }) {
  // Mounted only while Agent details is open, so these fetch only then; no count, nothing to ask.
  const tasks = useQuery({ ...agentTasksOptions(agent.slug), enabled: agent.openTasks > 0 }).data;
  const schedules = useQuery({
    ...schedulesListOptions({ target: agent.slug }),
    enabled: agent.scheduleCount > 0,
  }).data?.schedules;
  if (agent.openTasks === 0 && agent.scheduleCount === 0) return null;
  const now = new Date();
  return (
    <Section title="Work">
      {agent.openTasks > 0 && (
        <div className="grid gap-1">
          <ul className="grid gap-1">
            {tasks?.slice(0, MAX_WORK).map((t) => {
              const S = STATUS[t.status];
              return (
                <li key={t.key} className="flex min-w-0 items-baseline gap-1.5">
                  <S.Icon aria-hidden="true" className={`size-3 shrink-0 self-center ${S.icon}`} />
                  <Link
                    to="/tasks/$key"
                    params={{ key: t.key }}
                    className={`flex min-w-0 items-baseline gap-1.5 ${LINK_CLASS}`}
                  >
                    <span className="shrink-0 font-mono text-foreground">{t.key}</span>
                    <span className="min-w-0 truncate text-foreground">{t.title}</span>
                  </Link>
                  <span className="sr-only">{S.label}</span>
                </li>
              );
            })}
          </ul>
          <Link
            to="/tasks"
            search={{ assignee: agent.slug }}
            className={`justify-self-start ${LINK_CLASS}`}
          >
            All {plural(agent.openTasks, "task", "tasks")}
          </Link>
        </div>
      )}
      {agent.scheduleCount > 0 && (
        <div className="grid gap-1">
          <ul className="grid gap-1">
            {schedules?.slice(0, MAX_WORK).map((s) => (
              <li key={s.key} className="flex min-w-0 items-baseline justify-between gap-2">
                <Link
                  to="/schedules/$key"
                  params={{ key: s.key }}
                  className={`font-mono text-foreground ${LINK_CLASS}`}
                >
                  {s.key}
                </Link>
                <span className="truncate text-muted-foreground">
                  {s.nextRunAt ? (
                    <>
                      Next:{" "}
                      <ScheduleTime at={s.nextRunAt} zone={s.timezone} now={now} showZone={false} />
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to="/schedules"
            search={{ target: agent.slug }}
            className={`justify-self-start ${LINK_CLASS}`}
          >
            All {plural(agent.scheduleCount, "schedule", "schedules")}
          </Link>
        </div>
      )}
    </Section>
  );
}

function Usage({
  agent,
  usage,
}: {
  agent: AgentSummary;
  usage?: AgentUsageRow | null | undefined;
}) {
  const t = usage && (usage.kind === "ephemeral" ? usage.own : usage.total);
  const cost = t && t.turns > 0 ? formatCost(t.costUsd, t.turns) : null;
  return (
    <Section title="Usage">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground tabular-nums">
          {cost ? `${cost} est. · 7d` : usage === undefined ? "" : "No turns in the last 7 days"}
        </span>
        <Link
          to="/agents/$slug/usage"
          params={{ slug: agent.slug }}
          search={{}}
          className={LINK_CLASS}
        >
          Usage
        </Link>
      </div>
    </Section>
  );
}

function Runtime({ agent }: { agent: AgentSummary }) {
  return (
    <Section title="Runtime">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Template</dt>
        <dd className="min-w-0 truncate">
          <Link
            to="/templates/$name"
            params={{ name: agent.template }}
            className={`font-mono ${LINK_CLASS}`}
          >
            {agent.template}
          </Link>
        </dd>
        {agent.credential !== null && (
          <>
            <dt className="text-muted-foreground">Credential</dt>
            <dd className="min-w-0 truncate font-mono">{agent.credential}</dd>
          </>
        )}
        {agent.runtime === "docker" && (
          <>
            <dt className="text-muted-foreground">Image</dt>
            <dd className="min-w-0">
              <span className="font-mono [overflow-wrap:anywhere]">{agent.image ?? "Docker"}</span>
              {agent.pulling && " (pulling)"}
            </dd>
          </>
        )}
        {agent.projects.length > 0 && (
          <>
            <dt className="text-muted-foreground">Projects</dt>
            <dd className="flex min-w-0 flex-wrap gap-x-2 font-mono">
              {agent.projects.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {agent.runtime === "local" && (
        <p>
          Unsandboxed
          {agent.runtimeDisabled && (
            <span className="text-muted-foreground"> · disabled on this factory</span>
          )}
        </p>
      )}
    </Section>
  );
}

/**
 * The agent's facts, the same in the in-flow column, the sheet and the drawer (U2 §8.3). Mounted
 * only while open, so its task and schedule queries fire only then.
 */
export function AgentDetails({
  agent,
  stop,
  usage,
  onClose,
  slotsMax,
  onAgent,
}: {
  agent: AgentSummary;
  stop: StopCrons;
  /** The 7-day usage row; null once loaded without one for this agent, undefined while loading. */
  usage: AgentUsageRow | null | undefined;
  /** Shown in the sheet and drawer modes. */
  onClose?: (() => void) | undefined;
  /** For the queued detail. */
  slotsMax?: number | undefined;
  /** A fresh summary from a pin/unpin response. */
  onAgent?: ((a: AgentSummary) => void) | undefined;
}) {
  const canEdit = agent.kind === "persistent" && agent.archivedAt === null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-medium">Agent details</h2>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close agent details" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-1 border-b border-border px-4 py-3 text-[0.8125rem] leading-[1.125rem]">
          <p className="font-mono [overflow-wrap:anywhere]">@{agent.slug}</p>
          {agent.description && <Description text={agent.description} />}
        </div>
        <Now agent={agent} stop={stop} slotsMax={slotsMax} onAgent={onAgent} />
        <Org agent={agent} />
        <Work agent={agent} />
        <Usage agent={agent} usage={usage} />
        <Runtime agent={agent} />
      </div>
      {canEdit && (
        <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
          <Button asChild variant="outline">
            <Link to="/agents/$slug/edit" params={{ slug: agent.slug }}>
              Edit agent
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
