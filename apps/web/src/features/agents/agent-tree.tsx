import type { AgentSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { resetPhrase, StatusBadge } from "@/features/session/status-badge";
import { UnsandboxedBadge } from "@/features/session/unsandboxed-badge";
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

/** The org tree: depth-first in server order, one link per agent. Only the name cell indents, so
 *  the other columns stay aligned. */
export function AgentTree({ agents }: { agents: AgentSummary[] }) {
  const isMobile = useIsMobile();
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  // Depth as drawn: a row whose manager isn't in this list (the archived view) starts a new
  // root rather than hanging under nothing. Server order is depth-first, so managers come first.
  const shown = new Map<string, number>();
  for (const a of agents) {
    const m = a.reportsTo ? shown.get(a.reportsTo) : undefined;
    shown.set(a.slug, m === undefined ? 0 : m + 1);
  }
  return (
    <ul aria-label="Agents" className="divide-y divide-border border-y border-border">
      {agents.map((a) => {
        const manager = a.reportsTo ? bySlug.get(a.reportsTo) : undefined;
        const level = shown.get(a.slug) ?? 0;
        const depth = Math.min(level, isMobile ? MOBILE_DEPTH_CAP : level);
        const note = a.archivedAt ? null : agentNote(a);
        return (
          <li key={a.slug}>
            <Link
              to="/agents/$slug"
              params={{ slug: a.slug }}
              className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:grid md:grid-cols-[7rem_minmax(0,1fr)_10rem_10rem_auto] md:py-0"
            >
              <span className="flex w-28 shrink-0 items-center gap-1.5">
                {a.archivedAt ? (
                  <span className="inline-flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
                    {/* The empty dot slot keeps the label aligned with the live statuses. */}
                    <span aria-hidden="true" className="size-3" />
                    Archived
                  </span>
                ) : (
                  <StatusBadge status={a.status} size="short" />
                )}
                {a.restartPending && !a.archivedAt && (
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
                  <span className="min-w-0 truncate">{a.displayName}</span>
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
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
