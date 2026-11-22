import { useQuery } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildRows, deliveryFailedIds, interruptedTurnEnds } from "@/features/session/rows";
import { targetRowKey } from "@/features/session/timeline";
import { TimelineRow } from "@/features/session/timeline-row";
import { excerptOptions } from "./api";

const LIT = "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]";
// Excerpt rows aren't a roving list: no tab-key plumbing, so each row's own controls stay tabbable.
const rowProps = () => ({});

/** Static plates at excerpt row heights while the events load. */
export function ExcerptSkeleton() {
  return (
    <div data-pane-skeleton aria-hidden="true" className="grid gap-4">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="grid gap-1.5">
          <div className="h-3 w-24 rounded-sm bg-muted" />
          <div className="h-3 w-full rounded-sm bg-muted" />
          <div className="h-3 w-2/3 rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}

/**
 * A few rows of an agent's session for the reading pane (spec §11.2): 7 events around `seq` with the
 * target row highlighted and scrolled to the top of the pane, or the latest 7 without a `seq`. Rows
 * are `TimelineRow`s (no copy links, no roving tab key); tool rows still expand. Key it by target so
 * a switch never shows the previous excerpt or keeps its expanded rows.
 */
export function SessionExcerpt({
  slug,
  seq,
  spawned,
}: {
  slug: string;
  seq: number | undefined;
  /** The agent is a spawned one (an error row's fix never links to its edit page). */
  spawned?: boolean;
}) {
  const q = useQuery(excerptOptions(slug, seq));
  const events = q.data?.events;
  const view = useMemo(() => {
    if (!events) return undefined;
    const { rows } = buildRows(events);
    return {
      rows,
      failedIds: deliveryFailedIds(events),
      interruptedEnds: interruptedTurnEnds(events),
      target: seq === undefined ? undefined : targetRowKey(rows, seq),
    };
  }, [events, seq]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const lit = useRef<HTMLDivElement>(null);
  const target = view?.target;
  // Once the rows are in: the target row's top at the top of the pane's scroller (layout; jsdom only
  // sees the call). The pane body isn't the window, so the router's scroll reset doesn't undo it.
  useLayoutEffect(() => {
    if (target !== undefined) lit.current?.scrollIntoView?.({ block: "start" });
  }, [target]);

  if (q.isError)
    return <p className="text-sm text-muted-foreground">Couldn't load this session.</p>;
  if (!view) return <ExcerptSkeleton />;
  if (view.rows.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing in this session yet.</p>;
  return (
    <div className="grid gap-3">
      {view.rows.map((row) => {
        const isTarget = row.key === view.target;
        return (
          <div
            key={row.key}
            ref={isTarget ? lit : undefined}
            {...(isTarget ? { "data-highlighted": "true" } : {})}
            className={`min-w-0 scroll-mt-4 rounded-md ${row.kind === "message" || row.kind === "outgoing" ? "pt-3" : ""} ${isTarget ? LIT : ""}`}
          >
            <TimelineRow
              slug={slug}
              spawned={spawned}
              row={row}
              expanded={expanded}
              toggle={toggle}
              rowProps={rowProps}
              failedIds={view.failedIds}
              interruptedEnds={view.interruptedEnds}
            />
          </div>
        );
      })}
    </div>
  );
}
