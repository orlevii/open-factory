import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsQueryOptions } from "@/features/session/api";
import { StatusBadge } from "@/features/session/status-badge";

const MAX_ROWS = 8;
const ATTENTION = (a: AgentSummary) =>
  a.status === "errored" || a.status === "rate_limited" || a.stuck === true || a.restartPending;
const rank = (a: AgentSummary) => (ATTENTION(a) ? 0 : a.status === "working" ? 1 : 2);

/** Live persistent agents: needs attention first, then working, then the rest; ties by name then slug. */
export function orderHomeAgents(agents: AgentSummary[]) {
  return agents
    .filter((a) => a.kind === "persistent" && a.archivedAt === null)
    .sort(
      (x, y) =>
        rank(x) - rank(y) ||
        x.displayName.localeCompare(y.displayName) ||
        x.slug.localeCompare(y.slug),
    );
}

/** Home's Agents panel. The order freezes while the pointer or focus is inside, so rows never move under it. */
export function HomeAgents() {
  const q = useQuery(agentsQueryOptions);
  // Two flags: the pointer leaving while focus stays inside (or the reverse) must not unfreeze.
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  // The frozen slug order, captured in the handler that engages the panel (never set during render).
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const live = useMemo(() => (q.data ? orderHomeAgents(q.data) : undefined), [q.data]);
  const engage = () => setFrozen((f) => f ?? live?.map((a) => a.slug) ?? null);
  const release = (stillHovered: boolean, stillFocused: boolean) => {
    if (!stillHovered && !stillFocused) setFrozen(null);
  };
  // The frozen slugs mapped onto live data (rows update in place), departed slugs dropped, new slugs
  // appended; the live order when not frozen. Hovering before data arrives leaves `frozen` null.
  const shown = useMemo(() => {
    if (!live) return undefined;
    if (!frozen) return live;
    const bySlug = new Map(live.map((a) => [a.slug, a]));
    const known = new Set(frozen);
    return frozen
      .flatMap((slug) => bySlug.get(slug) ?? [])
      .concat(live.filter((a) => !known.has(a.slug)));
  }, [live, frozen]);

  let content: React.ReactNode;
  if (q.isError && !shown) content = <EmptyState text="Couldn't load agents." />;
  else if (!shown)
    content = (
      <div className="grid gap-2" aria-hidden="true">
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    );
  else if (shown.length === 0)
    content = (
      <div className="grid justify-items-start gap-2">
        <EmptyState text="No agents yet." />
        <Link to="/agents/new" className="text-sm underline underline-offset-2">
          New agent
        </Link>
      </div>
    );
  else
    content = (
      <ul aria-label="Agents" className="-mx-2 -my-2">
        {shown.slice(0, MAX_ROWS).map((a) => (
          <li key={a.slug}>
            <AgentRow agent={a} />
          </li>
        ))}
        {shown.length > MAX_ROWS && (
          <li>
            <Link
              to="/agents"
              className="of-row flex rounded-md px-2 py-1.5 text-[0.8125rem] text-muted-foreground"
            >
              All {shown.length} agents
            </Link>
          </li>
        )}
      </ul>
    );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only observes hover and focus to freeze the order.
    <div
      onPointerEnter={() => {
        setHovered(true);
        engage();
      }}
      onPointerLeave={() => {
        setHovered(false);
        release(false, focusWithin);
      }}
      onFocus={() => {
        setFocusWithin(true);
        engage();
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFocusWithin(false);
        release(hovered, false);
      }}
    >
      {content}
    </div>
  );
}

function AgentRow({ agent: a }: { agent: AgentSummary }) {
  const extra = a.restartPending ? "Restart pending" : a.stuck ? "Stuck" : null;
  return (
    <Link
      to="/agents/$slug"
      params={{ slug: a.slug }}
      className="of-row flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]"
    >
      <span className="shrink-0">
        <StatusBadge status={a.status} size="short" />
      </span>
      {extra && <span className="shrink-0 text-warning">{extra}</span>}
      <span className="min-w-0 truncate" title={a.displayName}>
        {a.displayName}
      </span>
      <span className="min-w-0 truncate font-mono text-muted-foreground">@{a.slug}</span>
    </Link>
  );
}
