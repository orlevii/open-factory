import type { SubagentProgress } from "@open-factory/shared";
import { memo, type RefObject, type TransitionEvent, useCallback } from "react";
import type { Arrival } from "@/lib/use-arrival";
import { childrenOf } from "./display-passes";
import { InLongPressRow } from "./long-press-region";
import { RowChrome, RowGutter, useRowLongPress } from "./row-chrome";
import type { RowMenuHandle } from "./row-menu";
import { isNoticeKind, type Row } from "./rows";
import { TimelineRow } from "./timeline-row";

/** A subagent card's live progress, or an overflow row's children's (U3 §12); `undefined` for every
 *  other row. Compared by identity. */
export type RowProgress = SubagentProgress | readonly (SubagentProgress | undefined)[] | undefined;

export type TimelineItemProps = {
  row: Row;
  agentRef: string;
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
  toggle(key: string, inner?: readonly string[]): void;
  onRowFocus(key: string): void;
  /** Live progress, passed only to subagent and overflow rows (U3 §11.4, B1). */
  progress?: RowProgress;
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
    a.agentRef !== b.agentRef ||
    a.spawned !== b.spawned ||
    a.lit !== b.lit ||
    a.arrivedKey !== b.arrivedKey ||
    a.arrival !== b.arrival ||
    a.onArrivedEnd !== b.onArrivedEnd ||
    a.firstOfSeq !== b.firstOfSeq ||
    a.toggle !== b.toggle ||
    a.onRowFocus !== b.onRowFocus ||
    a.progress !== b.progress
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
    row.kind === "message" ||
    row.kind === "outgoing" ||
    row.kind === "command" ||
    (row.kind === "text" && row.head);
  return speaks || prev.kind === "turn_footer" ? "mt-6" : "mt-2";
}

/** The rows' right gutter, a fixed 2rem column for the row menu (U3 §7.5): everything unboxed under
 *  the rows that should line up with them (the activity line, cancelled lines) uses it too. Cards
 *  span the full column instead, with the ⋯ inside their own padding. */
export const ROW_GUTTER = "pr-8";

/** A card (U3 §7.1): an envelope that crossed a session boundary. A factory notice is a quiet line. */
export function isCard(row: Row): boolean {
  if (row.kind === "outgoing" || row.kind === "spawn" || row.kind === "command") return true;
  return row.kind === "message" && !isNoticeKind(row.message.kind);
}

/** One timeline entry: the wrap (deep-link id, live fade), the row, its gutter time and its menu. */
export const TimelineItem = memo(function TimelineItem(p: TimelineItemProps) {
  const { row } = p;
  // A long-press on the row's chrome opens its menu through the menu's handle (U4 §11.2).
  const { menu, press } = useRowLongPress();
  return (
    <div
      {...press}
      data-row-wrap
      {...(p.firstOfSeq ? { id: `event-${row.seq}` } : {})}
      // A marker only (no style): the deep link's holder, kept for the page's life; the tint is
      // `data-arrived` on the row's own box (U3 §7.4).
      {...(p.lit ? { "data-highlighted": "true" } : {})}
      {...(p.live ? { "data-live": "" } : {})}
      className={`group relative min-w-0 rounded-md ${isCard(row) ? "" : ROW_GUTTER} ${p.gap}`}
    >
      <InLongPressRow value={true}>
        <ItemContent {...p} menuRef={menu} />
      </InLongPressRow>
    </div>
  );
}, itemPropsEqual);

/** The row, its gutter time and its menu, memoized apart from the wrap so the tab coming back (every
 *  live row's `live` turning false at once) re-renders only the wrap divs. `menuRef` isn't compared
 *  (`contentPropsEqual`): it is the wrap's `useRef`, one object for the item's life; a ref that could
 *  change would be ignored here. */
const ItemContent = memo(function ItemContent(
  p: TimelineItemProps & { menuRef: RefObject<RowMenuHandle | null> },
) {
  const { row, agentRef, toggle } = p;
  const onToggleCall = useCallback(() => toggle(row.key), [toggle, row.key]);
  // A live block or a raw send without a row has no seq to link to yet: its time and ⋯ come with the row.
  const chrome = !(row.kind === "text" && row.live) && !(row.kind === "command" && row.pending);
  return (
    <>
      {chrome && !isCard(row) && <RowGutter />}
      <TimelineRow
        agentRef={p.agentRef}
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
        toolTime={row.kind === "tool" ? row.at : undefined}
        progress={p.progress}
      />
      {chrome && (
        <RowChrome
          row={row}
          agentRef={agentRef}
          focusable={row.key === p.tabKey}
          callShown={p.expanded.has(row.key)}
          onToggleCall={onToggleCall}
          inCard={isCard(row)}
          menuRef={p.menuRef}
        />
      )}
    </>
  );
}, contentPropsEqual);
