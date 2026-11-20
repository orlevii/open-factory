import type { AgentSummary, AgentUsageRow } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { formatDay } from "@/features/session/format";
import { resetPhrase, StatusBadge } from "@/features/session/status-badge";
import { UnsandboxedBadge } from "@/features/session/unsandboxed-badge";
import { formatCost } from "@/features/usage/format";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/** Indentation per tree level inside the name cell; capped below `md` so names keep room. */
const INDENT = 20;
const MOBILE_DEPTH_CAP = 3;

function DockerBadge() {
  return (
    <span className="rounded-sm border border-border px-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      Docker
    </span>
  );
}

/** At most one muted note after the name (S5 UI design §4), by priority. Plain text: no interactive
 *  elements inside the row link. */
function agentNote(a: AgentSummary): string | null {
  if (a.runtimeDisabled) return "Local runtime disabled";
  if (a.status === "rate_limited") {
    const reset = resetPhrase(a);
    if (reset) return reset.bare;
  }
  const tasks = a.waitingOn.tasks.length;
  if (tasks > 0) return `Waiting on ${tasks} ${tasks === 1 ? "task" : "tasks"}`;
  const crons = a.waitingOn.crons;
  if (crons > 0) return crons === 1 ? "1 cron" : `${crons} crons`;
  return null;
}

/** An ended agent's note (S7 UI design §3): when it ended and what became of its workspace. */
function endedNote(a: AgentSummary, now: Date): string | null {
  const day = (iso: string) => formatDay(new Date(iso), now);
  if (a.terminatedAt) {
    const ended = `Terminated ${day(a.terminatedAt)}`;
    if (a.workspaceDeletedAt) return `${ended} · workspace deleted`;
    if (a.workspacePinned) return `${ended} · workspace pinned`;
    // Past the grace the sweep deletes it within minutes (a failing deletion is retried): a day in
    // the past would read as a broken promise.
    if (a.workspaceGraceEndsAt)
      return Date.parse(a.workspaceGraceEndsAt) <= now.getTime()
        ? `${ended} · workspace due for deletion`
        : `${ended} · workspace kept until ${day(a.workspaceGraceEndsAt)}`;
    return ended;
  }
  return a.archivedAt ? `Archived ${day(a.archivedAt)}` : null;
}

/** The display name; a spawned agent's " · ab12" tail never truncates (S7 UI design §3), since it is
 *  what tells siblings apart: the head gives way first. */
export function AgentName({ agent }: { agent: AgentSummary }) {
  const i = agent.kind === "ephemeral" ? agent.displayName.lastIndexOf(" · ") : -1;
  if (i <= 0) return <span className="min-w-0 truncate">{agent.displayName}</span>;
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="min-w-0 truncate">
        {agent.displayName.slice(0, i)}
      </span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">
        {" "}
        {agent.displayName.slice(i + 1)}
      </span>
      <span className="sr-only">{agent.displayName}</span>
    </span>
  );
}

/** The 7-day figure of a row: a persistent agent's total includes what it spawned; a spawned agent
 *  and every row of the flat Ended list show their own. */
function usageCell(row: AgentUsageRow | undefined, own: boolean) {
  const lead = "Estimated cost, last 7 days";
  // The response holds only agents with turns in the window (plus live persistent ones): a loaded
  // response without this agent means no turns.
  if (!row) return { text: "—", sr: `${lead}: none` };
  const t = own || row.kind === "ephemeral" ? row.own : row.total;
  const text = formatCost(t.costUsd, t.turns);
  const sr =
    t.turns === 0
      ? `${lead}: none`
      : !own && row.kind === "persistent" && row.spawned && row.spawned.turns > 0
        ? `${lead}: ${text} (own ${formatCost(row.own.costUsd, row.own.turns)}, spawned ${formatCost(row.spawned.costUsd, row.spawned.turns)})`
        : `${lead}: ${text}`;
  return { text, sr };
}

/** The org tree: depth-first in server order, one link per agent. Only the name cell indents, so
 *  the other columns stay aligned. `flat` (the Ended view) keeps server order with no nesting. */
export function AgentTree({
  agents,
  flat = false,
  usage,
}: {
  agents: AgentSummary[];
  flat?: boolean;
  /** 7-day usage by slug; the cost cell stays empty until it arrives. */
  usage?: Map<string, AgentUsageRow>;
}) {
  const isMobile = useIsMobile();
  const now = new Date();
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  // Depth as drawn: a row whose manager isn't in this list starts a new root rather than hanging
  // under nothing. Server order is depth-first, so managers come first.
  const shown = new Map<string, number>();
  for (const a of agents) {
    const m = !flat && a.reportsTo ? shown.get(a.reportsTo) : undefined;
    shown.set(a.slug, m === undefined ? 0 : m + 1);
  }
  return (
    <ul aria-label="Agents" className="divide-y divide-border border-y border-border">
      {agents.map((a) => {
        const manager = a.reportsTo ? bySlug.get(a.reportsTo) : undefined;
        const level = shown.get(a.slug) ?? 0;
        const depth = Math.min(level, isMobile ? MOBILE_DEPTH_CAP : level);
        const ended = a.archivedAt !== null || a.status === "terminated";
        // Empty while usage is loading or failed; a dash once loaded without a row for this agent.
        const cost = usage ? usageCell(usage.get(a.slug), flat) : null;
        const note = ended ? endedNote(a, now) : agentNote(a);
        return (
          <li key={a.slug}>
            <Link
              to="/agents/$slug"
              params={{ slug: a.slug }}
              className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:grid md:grid-cols-[7rem_minmax(0,1fr)_10rem_10rem_auto_4rem] md:py-0"
            >
              <span className="flex w-28 shrink-0 items-center gap-1.5">
                {a.archivedAt && a.status !== "terminated" ? (
                  <span className="inline-flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
                    {/* The empty dot slot keeps the label aligned with the live statuses. */}
                    <span aria-hidden="true" className="size-3" />
                    Archived
                  </span>
                ) : (
                  <StatusBadge status={a.status} size="short" />
                )}
                {a.restartPending && !ended && (
                  <>
                    <RotateCw aria-hidden="true" className="size-3 text-muted-foreground" />
                    <span className="sr-only">restart pending</span>
                  </>
                )}
              </span>
              <span
                data-depth={level}
                className="min-w-0 flex-1"
                style={{ paddingLeft: `${depth * INDENT}px` }}
              >
                <span
                  className={cn(
                    "relative flex min-w-0 items-baseline gap-2",
                    // The └ elbow: a 1px rule corner drawn just before a nested name.
                    level > 0 &&
                      "pl-3.5 before:absolute before:top-0 before:left-0.5 before:h-[0.6875rem] before:w-2 before:border-b before:border-l before:border-border",
                  )}
                >
                  <AgentName agent={a} />
                  {/* Inline, not a second line, so live updates never change the row height. It
                      gives way (truncates) before the name does. */}
                  {note && (
                    <span
                      data-agent-note
                      className="min-w-0 shrink-[1000] truncate text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
                    >
                      {note}
                    </span>
                  )}
                </span>
                {a.reportsTo && (
                  <span className="sr-only">
                    {" "}
                    {manager
                      ? `reports to ${manager.displayName} (@${manager.slug})`
                      : `reports to @${a.reportsTo}`}
                  </span>
                )}
              </span>
              {/* Below md these wrap onto a second line; from md they are grid cells. */}
              <span className="flex basis-full flex-wrap items-center gap-x-4 gap-y-0.5 md:contents">
                <span className="min-w-0 truncate font-mono text-[0.8125rem] text-muted-foreground">
                  {a.slug}
                </span>
                <span className="min-w-0 truncate font-mono text-[0.8125rem] text-muted-foreground">
                  {a.template}
                </span>
                <span className="md:justify-self-end">
                  {a.runtime === "local" ? <UnsandboxedBadge /> : <DockerBadge />}
                </span>
              </span>
              {cost && (
                <span className="hidden text-right text-[0.8125rem] text-muted-foreground tabular-nums md:block">
                  <span aria-hidden="true">{cost.text}</span>
                  <span className="sr-only">{cost.sr}</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
