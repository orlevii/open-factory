import type { TaskSummary } from "@open-factory/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { AgentChip, PrincipalChip } from "@/components/agent-chip";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { formatInboxTime } from "@/features/session/format";
import { onRowKeyDown, skipFocusPreload } from "@/lib/row-nav";
import { runInstantOn } from "@/lib/run-instant";
import { shouldIgnore } from "@/lib/shortcuts";
import { PREFETCH_REST_MS } from "@/lib/timing";
import { type TaskFilters, taskDetailOptions, tasksListOptions } from "./api";
import { BlockedMarker, STATUS, StatusLabel } from "./status-label";
import { isDefault } from "./task-filters";

function Assignee({ t }: { t: TaskSummary }) {
  if (!t.assignee) return <span className="text-muted-foreground">Unassigned</span>;
  const chip = <AgentChip slug={t.assignee.slug} name={t.assignee.displayName} size={20} />;
  if (t.assignee.ended)
    return (
      <span data-assignee className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {chip}
        <span className="shrink-0">· {t.assignee.ended}</span>
      </span>
    );
  return (
    <span data-assignee className="flex min-w-0 text-foreground">
      {chip}
    </span>
  );
}

function label(t: TaskSummary) {
  const assignee = t.assignee
    ? `assigned to @${t.assignee.slug}${t.assignee.ended ? ` (${t.assignee.ended})` : ""}`
    : "unassigned";
  const blocked = t.blockedBy.length ? `, blocked by ${t.blockedBy.join(", ")}` : "";
  return `${t.key}, ${t.title}, ${STATUS[t.status].label}${blocked}, ${assignee}`;
}

/** Space peeks only when the list keeps 24rem beside the 30rem sheet (spec §12); else the page opens. */
const PEEK_MIN_REM = 54;
function roomToPeek(list: HTMLElement): boolean {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return list.clientWidth >= PEEK_MIN_REM * rem;
}

/** The list's row for a task (the peek's close returns focus to it), if it is shown. */
export function findTaskRow(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `ul[data-task-list] a[data-task-key="${CSS.escape(key)}"]`,
  );
}

/** The page's one task peek, as the list drives it. */
export type TaskPeekControl = {
  /** The task shown, or null when closed. */
  key: string | null;
  show(key: string): void;
  /** Closes it at once (a key closed it). */
  close(): void;
  /** Moves focus into it (F6). */
  focus(): void;
};

const Row = memo(function Row({
  t,
  now,
  selected,
}: {
  t: TaskSummary;
  now: Date;
  /** The peek shows this task. */
  selected: boolean;
}) {
  const at = new Date(t.updatedAt);
  const time = formatInboxTime(at, now);
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to="/tasks/$key"
        params={{ key: t.key }}
        search={{}}
        aria-label={label(t)}
        aria-current={selected ? "true" : undefined}
        onFocus={skipFocusPreload}
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
              <span className="inline-flex items-center gap-1.5 align-middle">
                created by <PrincipalChip principal={t.createdBy} size={20} />
              </span>
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
});

/** The Tasks page's list (UI design §5): a plain `<ul>` of links, newest updated first, 50 per page.
 *  A click or Enter opens the task's page; with `peek`, Space peeks the focused row (or opens the page
 *  when the list is too narrow to keep room beside the sheet), retargets an open peek to it, or closes
 *  the peek on the row it shows; `j`/`k` retarget the open peek. */
export function TaskList({
  filters,
  onChange,
  peek,
}: {
  filters: TaskFilters;
  onChange(next: TaskFilters): void;
  peek?: TaskPeekControl;
}) {
  const q = useInfiniteQuery(tasksListOptions(filters));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useRef<HTMLUListElement>(null);
  const tasks = q.data;
  // The rows' times are relative to when the data last changed, so a retarget doesn't re-render every row.
  const now = useMemo(() => (tasks ? new Date() : new Date(0)), [tasks]);

  // The open peek's neighbours, once the selection has rested (a j/k sweep fetches nothing extra).
  const peekKey = peek?.key ?? null;
  const index = peekKey && tasks ? tasks.findIndex((t) => t.key === peekKey) : -1;
  const prevKey = index > 0 ? tasks?.[index - 1]?.key : undefined;
  const nextKey = index >= 0 ? tasks?.[index + 1]?.key : undefined;
  useEffect(() => {
    if (!prevKey && !nextKey) return;
    const timer = setTimeout(() => {
      for (const k of [prevKey, nextKey]) if (k) void qc.prefetchQuery(taskDetailOptions(k));
    }, PREFETCH_REST_MS);
    return () => clearTimeout(timer);
  }, [prevKey, nextKey, qc]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const row = onRowKeyDown(e);
    const el = list.current;
    if (!peek || !el) return;
    if (row && peek.key !== null && (e.key === "j" || e.key === "k")) {
      const key = row.dataset.taskKey;
      if (key && key !== peek.key) runInstantOn(el, () => peek.show(key));
      return;
    }
    if (e.key === "F6" && peek.key !== null) {
      e.preventDefault();
      peek.focus();
      return;
    }
    if (e.key !== " " || !(e.target instanceof HTMLAnchorElement) || shouldIgnore(e.nativeEvent))
      return;
    const key = e.target.dataset.taskKey;
    if (!key) return;
    e.preventDefault(); // Space would scroll the page
    // Space on the row the peek shows closes it; on another row it swaps the peek to that task in
    // place (the j/k swap), so the sheet doesn't close and reopen.
    if (peek.key === key) peek.close();
    else if (peek.key !== null) runInstantOn(el, () => peek.show(key));
    else if (roomToPeek(el)) runInstantOn(el, () => peek.show(key));
    else void navigate({ to: "/tasks/$key", params: { key }, search: {} });
  };

  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a") ?? [])];
    const i = links.findIndex((l) => l.dataset.taskKey === focusAfter) + 1;
    (links[i] ?? links.at(-1))?.focus();
  }, [focusAfter]);
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
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <ul
        ref={list}
        aria-label="Tasks"
        data-task-list=""
        onKeyDown={onKeyDown}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {tasks.map((t) => (
          <Row key={t.key} t={t} now={now} selected={t.key === peekKey} />
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
