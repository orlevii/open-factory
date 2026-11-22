import { type ReactNode, type Ref, useCallback, useRef } from "react";
import { type PickPressed, useLongPress } from "@/hooks/use-long-press";
import { formatTime } from "./format";
import { RowMenu, type RowMenuHandle, rowMenuItems, rowMenuTitle } from "./row-menu";
import type { Row } from "./rows";

/** Agent text shows its time in the gutter on hover or focus (U3 §7.5); a head text row's speaker
 *  line already shows it, messages keep their visible time, and a tool row, top-level or a folded
 *  run's call, puts it in its own line (`ToolCallRow`'s `time`), so it never covers the state. */
export function gutterTime(row: Row): string | undefined {
  if (row.kind === "subagent" || (row.kind === "text" && !row.head)) return row.at;
  return undefined;
}

// Shown on hover or focus within the row's own box: the timeline item's `group`, or a nested row's
// `group/call` (so hovering one call never shows its siblings' time).
const TIME_SHOWN = {
  top: "group-focus-within:flex group-hover:flex",
  nested: "group-focus-within/call:flex group-hover/call:flex",
} as const;

/**
 * A timeline long-press (U4 §11.2) starts only on a row's chrome: its speaker line, a tool row's summary
 * line or its gutter (`data-longpress-region`), never its prose. The owner is the timeline item's wrap
 * or a nested row's box, whichever holds the region nearest; it must have a menu. The press lands on
 * the row's own box: a message's card, otherwise the row.
 */
export const pickRowBox: PickPressed = (e) => {
  const owner = e.currentTarget;
  const region = e.target instanceof Element ? e.target.closest("[data-longpress-region]") : null;
  if (!region || region.closest("[data-call], [data-row-wrap]") !== owner) return null;
  if (!owner.querySelector(":scope > [data-row-menu]")) return null;
  const row = owner.querySelector("[data-row]");
  return row ? (row.querySelector(":scope > [data-message-block]") ?? row) : null;
};

/** Long-press handlers for a row's owner box, opening its menu at the point through the menu's handle,
 *  so no menu state lives in the (memoized) row. Both are stable. */
export function useRowLongPress() {
  const menu = useRef<RowMenuHandle>(null);
  const onLongPress = useCallback((at: { x: number; y: number }) => menu.current?.openAt(at), []);
  return { menu, press: useLongPress(onLongPress, { pick: pickRowBox }) };
}

/**
 * The gutter column of a row with a menu (a card has none): a long-press region, on touch only. It must
 * come first in its box: positioned boxes without a z-index paint and hit-test in tree order, so a
 * nested row's ⋯ and gutter, later in the tree, stay on top of it.
 */
export function RowGutter() {
  return (
    <div
      aria-hidden="true"
      data-row-gutter=""
      data-longpress-region=""
      className="absolute inset-y-0 right-0 hidden w-8 pointer-coarse:block"
    />
  );
}

/** A row's gutter time and its one ⋯ (U3 §7.5), at the right of the nearest `relative` box. The menu's
 *  list is built per row object, and only when the menu first opens. */
export function RowChrome({
  row,
  slug,
  focusable,
  callShown,
  onToggleCall,
  nested = false,
  inCard = false,
  menuRef,
}: {
  row: Row;
  slug: string;
  /** The row is the timeline's tab stop. */
  focusable: boolean;
  callShown: boolean;
  onToggleCall(): void;
  /** Inside another row (a folded run's call): hover and focus are its own box's. */
  nested?: boolean;
  /** The row is a card: the ⋯ sits inside its padding (U3 §7.1). */
  inCard?: boolean;
  /** The menu's handle, for a long-press on the row. */
  menuRef?: Ref<RowMenuHandle>;
}) {
  const items = useCallback(() => rowMenuItems(row, slug), [row, slug]);
  const title = useCallback(() => rowMenuTitle(row, slug), [row, slug]);
  const time = gutterTime(row);
  return (
    <>
      {time !== undefined && (
        // Content | time | ⋯: the time sits just left of the menu, over the text row's end (agent text
        // has nothing there).
        <time
          data-gutter-time
          dateTime={time}
          title={new Date(time).toLocaleString()}
          className={`pointer-events-none absolute top-1 right-8 hidden h-6 items-center bg-background px-1 text-[0.8125rem] text-muted-foreground tabular-nums ${nested ? TIME_SHOWN.nested : TIME_SHOWN.top} pointer-coarse:hidden!`}
        >
          {formatTime(time)}
        </time>
      )}
      <RowMenu
        ref={menuRef}
        items={items}
        title={title}
        focusable={focusable}
        callShown={callShown}
        onToggleCall={onToggleCall}
        nested={nested}
        inCard={inCard}
      />
    </>
  );
}

/**
 * A row inside another row's body (a folded run's call; PR4's subagent children reuse it): its own
 * `relative` box reaching into the timeline's right gutter (`-mr-8 pr-8`), so its time and ⋯ line up
 * with the top-level rows', shown on hover or focus of this box only.
 */
export function NestedRow({
  children,
  ...chrome
}: Omit<Parameters<typeof RowChrome>[0], "nested" | "menuRef"> & { children: ReactNode }) {
  const { menu, press } = useRowLongPress();
  return (
    <div data-call className="group/call relative -mr-8 pr-8" {...press}>
      <RowGutter />
      {children}
      <RowChrome {...chrome} nested menuRef={menu} />
    </div>
  );
}
