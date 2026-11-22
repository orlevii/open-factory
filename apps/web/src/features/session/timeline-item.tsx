import { memo } from "react";
import { CopyLink } from "./copy-link";
import type { Row } from "./rows";
import { TimelineRow } from "./timeline-row";

export type TimelineItemProps = {
  row: Row;
  slug: string;
  spawned?: boolean;
  /** The deep-link tint is on this row. */
  lit: boolean;
  /** The first row of its seq carries `id="event-<seq>"` (a message_in can render several rows). */
  firstOfSeq: boolean;
  tabKey: string | undefined;
  expanded: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
  toggle(key: string): void;
  onRowFocus(key: string): void;
};

function subtree(row: Row, out: Row[] = []): Row[] {
  out.push(row);
  if (row.kind === "tool") for (const c of row.children) subtree(c, out);
  return out;
}

/** Re-render only when this row, or something that decides how it or a descendant looks, changed
 *  (spec §9.4). */
export function itemPropsEqual(a: TimelineItemProps, b: TimelineItemProps): boolean {
  if (
    a.row !== b.row ||
    a.slug !== b.slug ||
    a.spawned !== b.spawned ||
    a.lit !== b.lit ||
    a.firstOfSeq !== b.firstOfSeq ||
    a.toggle !== b.toggle ||
    a.onRowFocus !== b.onRowFocus
  )
    return false;
  // Identity fast path: same shared sets and the same tab row, so nothing per-row can differ.
  if (
    a.expanded === b.expanded &&
    a.failedIds === b.failedIds &&
    a.interruptedEnds === b.interruptedEnds &&
    a.tabKey === b.tabKey
  )
    return true;
  for (const r of subtree(a.row)) {
    if (a.expanded.has(r.key) !== b.expanded.has(r.key)) return false;
    if ((a.tabKey === r.key) !== (b.tabKey === r.key)) return false;
    if (a.interruptedEnds.has(r.seq) !== b.interruptedEnds.has(r.seq)) return false;
    if (r.kind === "message" && a.failedIds.has(r.message.id) !== b.failedIds.has(r.message.id))
      return false;
  }
  return true;
}

/** One timeline entry: the wrap (deep-link id and tint), the row and its Copy link. */
export const TimelineItem = memo(function TimelineItem(p: TimelineItemProps) {
  const { row } = p;
  return (
    <div
      data-row-wrap
      {...(p.firstOfSeq ? { id: `event-${row.seq}` } : {})}
      {...(p.lit ? { "data-highlighted": "true" } : {})}
      className={`group relative min-w-0 rounded-md pr-8 ${row.kind === "message" || row.kind === "outgoing" ? "pt-3" : ""} ${p.lit ? "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]" : ""}`}
    >
      <TimelineRow
        slug={p.slug}
        spawned={p.spawned}
        row={row}
        expanded={p.expanded}
        toggle={p.toggle}
        rowProps={(r) => ({
          "data-row": r.key,
          tabIndex: r.key === p.tabKey ? 0 : -1,
          onFocus: () => p.onRowFocus(r.key),
        })}
        failedIds={p.failedIds}
        interruptedEnds={p.interruptedEnds}
      />
      <CopyLink
        url={`${location.origin}/agents/${encodeURIComponent(p.slug)}?event=${row.seq}`}
        focusable={row.key === p.tabKey}
      />
    </div>
  );
}, itemPropsEqual);
