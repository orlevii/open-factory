import type { TaskSummary } from "@open-factory/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { formatInboxTime } from "@/features/session/format";
import { onRowKeyDown } from "@/lib/row-nav";
import { type TaskFilters, tasksListOptions } from "./api";
import { BlockedMarker, STATUS, StatusLabel } from "./status-label";
import { isDefault } from "./task-filters";

const who = (c: TaskSummary["createdBy"]) => (c.kind === "agent" ? `@${c.slug}` : `@${c.handle}`);

function Assignee({ t }: { t: TaskSummary }) {
  if (!t.assignee) return <span className="text-muted-foreground">Unassigned</span>;
  if (t.assignee.ended)
    return (
      <span className="text-muted-foreground">
        <span className="font-mono">@{t.assignee.slug}</span> · {t.assignee.ended}
      </span>
    );
  return <span className="font-mono text-foreground">@{t.assignee.slug}</span>;
}

function label(t: TaskSummary) {
  const assignee = t.assignee
    ? `assigned to @${t.assignee.slug}${t.assignee.ended ? ` (${t.assignee.ended})` : ""}`
    : "unassigned";
  const blocked = t.blockedBy.length ? `, blocked by ${t.blockedBy.join(", ")}` : "";
  return `${t.key}, ${t.title}, ${STATUS[t.status].label}${blocked}, ${assignee}`;
}

function Row({ t, now }: { t: TaskSummary; now: Date }) {
  const at = new Date(t.updatedAt);
  const time = formatInboxTime(at, now);
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to="/tasks/$key"
        params={{ key: t.key }}
        search={{}}
        aria-label={label(t)}
        data-task-key={t.key}
        className="of-row grid min-h-14 grid-cols-[3.5rem_minmax(0,1fr)] content-center gap-x-3 gap-y-0.5 px-2 py-2 text-sm md:grid-cols-[3.5rem_minmax(0,1fr)_7rem_10rem]"
      >
        <span className="font-mono text-[0.8125rem] leading-5 text-foreground">{t.key}</span>
        <span className="min-w-0 truncate leading-5 text-foreground">{t.title}</span>
        {/* One element tree for both layouts: below md the status, assignee and meta flow on line 2; from md the
            status and assignee take their columns on line 1 and the meta sits under the title. */}
        <span className="col-start-2 flex flex-wrap items-center gap-x-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:contents">
          <StatusLabel status={t.status} className="md:col-start-3 md:row-start-1 md:leading-5" />
          <span aria-hidden="true" className="md:hidden">
            ·
          </span>
          <span className="min-w-0 truncate md:col-start-4 md:row-start-1 md:leading-5">
            <Assignee t={t} />
          </span>
          <span aria-hidden="true" className="md:hidden">
            ·
          </span>
          <span className="contents md:col-span-3 md:col-start-2 md:row-start-2 md:flex md:flex-wrap md:items-center md:gap-x-1.5">
            {t.blockedBy.length > 0 && (
              <>
                <BlockedMarker keys={t.blockedBy} />
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="max-md:hidden">
              created by <span className="font-mono">{who(t.createdBy)}</span>
            </span>
            <span aria-hidden="true" className="max-md:hidden">
              ·
            </span>
            <span>
              updated{" "}
              <time dateTime={t.updatedAt} title={at.toLocaleString()}>
                {time}
              </time>
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The Tasks page's list (UI design §5): a plain `<ul>` of links, newest updated first, 50 per page. */
export function TaskList({
  filters,
  onChange,
}: {
  filters: TaskFilters;
  onChange(next: TaskFilters): void;
}) {
  const q = useInfiniteQuery(tasksListOptions(filters));
  const list = useRef<HTMLUListElement>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a") ?? [])];
    const i = links.findIndex((l) => l.dataset.taskKey === focusAfter) + 1;
    (links[i] ?? links.at(-1))?.focus();
  }, [focusAfter]);
  const tasks = q.data;
  if (!tasks)
    return q.isError ? (
      <ErrorLine text="Couldn't load tasks." onRetry={() => void q.refetch()} />
    ) : null;
  if (tasks.length === 0) {
    if (isDefault(filters))
      return (
        <div className="grid justify-items-start gap-2">
          <EmptyState text="No open tasks." />
          <Button variant="ghost" onClick={() => onChange({ status: "all" })}>
            Show all tasks
          </Button>
        </div>
      );
    if (filters.status === "all" && !filters.assignee && !filters.unassigned && !filters.creator)
      return <EmptyState text="No tasks yet." />;
    return (
      <div className="grid justify-items-start gap-2">
        <EmptyState text="No tasks match these filters." />
        <Button variant="ghost" onClick={() => onChange({ status: "open_in_progress" })}>
          Clear filters
        </Button>
      </div>
    );
  }
  const loadMore = () => {
    const last = tasks.at(-1)?.key;
    void q.fetchNextPage().then((r) => {
      if (r.isSuccess && last !== undefined) setFocusAfter(last);
    });
  };
  const now = new Date();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ul
        ref={list}
        aria-label="Tasks"
        onKeyDown={onRowKeyDown}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {tasks.map((t) => (
          <Row key={t.key} t={t} now={now} />
        ))}
      </ul>
      {q.isFetchNextPageError ? (
        <ErrorLine text="Couldn't load more tasks." onRetry={loadMore} autoFocus />
      ) : (
        q.hasNextPage && (
          <Button
            variant="outline"
            className="w-full"
            onClick={loadMore}
            disabled={q.isFetchingNextPage}
          >
            Load more
          </Button>
        )
      )}
    </div>
  );
}
