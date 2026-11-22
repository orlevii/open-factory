import { memo } from "react";
import { CopyLink } from "./copy-link";
import { childrenOf } from "./display-passes";
import type { Row } from "./rows";
import { TimelineRow } from "./timeline-row";

export type TimelineItemProps = {
  row: Row;
  slug: string;
  spawned?: boolean;
  /** The deep-link tint is on this row. */
  lit: boolean;
  /** Arrived by a live frame and replaces nothing on screen: it fades in once (U3 §8.3). */
  live: boolean;
  /** The first row of its seq carries `id="event-<seq>"` (a message_in can render several rows). */
  firstOfSeq: boolean;
  /** The space above this row (U3 §7.1), from `rowGap`: a class name, so a primitive. */
  gap: string;
  tabKey: string | undefined;
  expanded: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
  interruptedEnds: ReadonlySet<number>;
  toggle(key: string): void;
  onRowFocus(key: string): void;
};

function subtree(row: Row, out: Row[] = []): Row[] {
  out.push(row);
  for (const c of childrenOf(row)) subtree(c, out);
  return out;
}

/** Re-render only when this row, or something that decides how it or a descendant looks, changed
 *  (spec §9.4). */
export function itemPropsEqual(a: TimelineItemProps, b: TimelineItemProps): boolean {
  return a.live === b.live && a.gap === b.gap && contentPropsEqual(a, b);
}

/** Everything but `live` and `gap`: a flip re-renders only the wrap, never the row inside (U3 §8.3). */
function contentPropsEqual(a: TimelineItemProps, b: TimelineItemProps): boolean {
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

/** Spacing replaces boxes for grouping (U3 §7.1): 24px before a speaker line or a card and after a
 *  turn footer, 8px between rows inside a turn; nothing above the first row. From the two rows' kinds
 *  and `head` only, so the class is a primitive and stays put while neither row changes kind. */
export function rowGap(row: Row, prev: Row | undefined): string {
  if (!prev) return "";
  const speaks =
    row.kind === "message" || row.kind === "outgoing" || (row.kind === "text" && row.head);
  return speaks || prev.kind === "turn_footer" ? "mt-6" : "mt-2";
}

/** The rows' right gutter (room for Copy link): everything under the rows that should line up with them
 *  (the activity line, queued and Sending blocks, cancelled lines) uses it too. */
export const ROW_GUTTER = "pr-8";

/** One timeline entry: the wrap (deep-link id, tint, live fade), the row and its Copy link. */
export const TimelineItem = memo(function TimelineItem(p: TimelineItemProps) {
  const { row } = p;
  return (
    <div
      data-row-wrap
      {...(p.firstOfSeq ? { id: `event-${row.seq}` } : {})}
      {...(p.lit ? { "data-highlighted": "true" } : {})}
      {...(p.live ? { "data-live": "" } : {})}
      className={`group relative min-w-0 rounded-md ${ROW_GUTTER} ${p.gap} ${p.lit ? "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]" : ""}`}
    >
      <ItemContent {...p} />
    </div>
  );
}, itemPropsEqual);

/** The row and its Copy link, memoized apart from the wrap so the tab coming back (every live row's
 *  `live` turning false at once) re-renders only the wrap divs. */
const ItemContent = memo(function ItemContent(p: TimelineItemProps) {
  const { row } = p;
  return (
    <>
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
    </>
  );
}, contentPropsEqual);
