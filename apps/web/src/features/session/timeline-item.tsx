import { memo, type TransitionEvent, useCallback, useMemo } from "react";
import { childrenOf } from "./display-passes";
import { formatTime } from "./format";
import { RowMenu, rowMenuItems } from "./row-menu";
import type { Row } from "./rows";
import { TimelineRow } from "./timeline-row";

/** The deep-link tint: shown, then fading over 300ms until its `transitionend`. */
export type Arrival = "on" | "fading";

export type TimelineItemProps = {
  row: Row;
  slug: string;
  spawned?: boolean;
  /** This item holds the deep-link target (the row itself, or one of its children). */
  lit: boolean;
  /** The row the deep link landed on, when this item holds it: it carries the tint (U3 §7.4). */
  arrivedKey: string | undefined;
  /** The tint's phase on `arrivedKey`; undefined once it has faded. */
  arrival: Arrival | undefined;
  /** The tint's fade finished. Stable. */
  onArrivedEnd(): void;
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
    a.arrivedKey !== b.arrivedKey ||
    a.arrival !== b.arrival ||
    a.onArrivedEnd !== b.onArrivedEnd ||
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

/** The rows' right gutter, a fixed 2rem column for the row menu (U3 §7.5): everything under the rows that should line up with them
 *  (the activity line, queued and Sending blocks, cancelled lines) uses it too. */
export const ROW_GUTTER = "pr-8";

/** One timeline entry: the wrap (deep-link id, live fade), the row, its gutter time and its menu. */
export const TimelineItem = memo(function TimelineItem(p: TimelineItemProps) {
  const { row } = p;
  return (
    <div
      data-row-wrap
      {...(p.firstOfSeq ? { id: `event-${row.seq}` } : {})}
      {...(p.lit ? { "data-highlighted": "true" } : {})}
      {...(p.live ? { "data-live": "" } : {})}
      className={`group relative min-w-0 rounded-md ${ROW_GUTTER} ${p.gap}`}
    >
      <ItemContent {...p} />
    </div>
  );
}, itemPropsEqual);

/** Agent text and tool rows show their time in the gutter on hover or focus (U3 §7.5); a head text
 *  row's speaker line already shows it, and messages keep their visible time. */
function gutterTime(row: Row): string | undefined {
  if (row.kind === "tool" || (row.kind === "text" && !row.head)) return row.at;
  return undefined;
}

/** The row, its gutter time and its menu, memoized apart from the wrap so the tab coming back (every
 *  live row's `live` turning false at once) re-renders only the wrap divs. */
const ItemContent = memo(function ItemContent(p: TimelineItemProps) {
  const { row, slug, toggle } = p;
  // Plain data per row object: a re-render for any other reason reuses the list.
  const items = useMemo(() => rowMenuItems(row, slug), [row, slug]);
  const onToggleCall = useCallback(() => toggle(row.key), [toggle, row.key]);
  const time = gutterTime(row);
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
          // The tint sits on the row's own box (the card or the row), never the wrap (U3 §7.4).
          ...(r.key === p.arrivedKey && p.arrival
            ? {
                "data-arrived": p.arrival === "fading" ? "fading" : "",
                onTransitionEnd: (e: TransitionEvent) => {
                  // Only the tint's own fade: a child's transition bubbles here too.
                  if (e.target !== e.currentTarget || p.arrival !== "fading") return;
                  if (e.propertyName && e.propertyName !== "opacity") return;
                  p.onArrivedEnd();
                },
              }
            : {}),
        })}
        failedIds={p.failedIds}
        interruptedEnds={p.interruptedEnds}
      />
      {time !== undefined && (
        // Content | chip | time | ⋯: the time sits just left of the menu, over the row's end.
        <time
          data-gutter-time
          dateTime={time}
          title={new Date(time).toLocaleString()}
          className="absolute top-1 right-8 hidden h-6 items-center bg-background px-1 text-[0.8125rem] text-muted-foreground tabular-nums group-focus-within:flex group-hover:flex pointer-coarse:hidden!"
        >
          {formatTime(time)}
        </time>
      )}
      <RowMenu
        items={items}
        focusable={row.key === p.tabKey}
        callShown={p.expanded.has(row.key)}
        onToggleCall={onToggleCall}
      />
    </>
  );
}, contentPropsEqual);
