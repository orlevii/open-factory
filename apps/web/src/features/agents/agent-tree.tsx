import type { AgentSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { StatusBadge } from "@/features/session/status-badge";
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

/** The org tree: depth-first in server order, one link per agent. Only the name cell indents, so
 *  the other columns stay aligned. */
export function AgentTree({ agents }: { agents: AgentSummary[] }) {
  const isMobile = useIsMobile();
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  return (
    <ul aria-label="Agents" className="divide-y divide-border border-y border-border">
      {agents.map((a) => {
        const manager = a.reportsTo ? bySlug.get(a.reportsTo) : undefined;
        const depth = Math.min(a.depth, isMobile ? MOBILE_DEPTH_CAP : a.depth);
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
                  <StatusBadge status={a.status} />
                )}
                {a.restartPending && !a.archivedAt && (
                  <>
                    <RotateCw aria-hidden="true" className="size-3 text-muted-foreground" />
                    <span className="sr-only">restart pending</span>
                  </>
                )}
              </span>
              <span
                data-depth={a.depth}
                className="min-w-0 flex-1"
                style={{ paddingLeft: `${depth * INDENT}px` }}
              >
                <span
                  className={cn(
                    "relative block truncate",
                    // The └ elbow: a 1px rule corner drawn just before a nested name.
                    a.depth > 0 &&
                      "pl-3.5 before:absolute before:top-0 before:left-0.5 before:h-[0.6875rem] before:w-2 before:border-b before:border-l before:border-border",
                  )}
                >
                  {a.displayName}
                </span>
                {manager && (
                  <span className="sr-only">
                    {" "}
                    reports to {manager.displayName} (@{manager.slug})
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
