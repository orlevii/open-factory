import { type ReactNode, useCallback } from "react";
import { formatTime } from "./format";
import { RowMenu, rowMenuItems } from "./row-menu";
import type { Row } from "./rows";

/** Agent text shows its time in the gutter on hover or focus (U3 §7.5); a head text row's speaker
 *  line already shows it, messages keep their visible time, and a tool row, top-level or a folded
 *  run's call, puts it in its own line (`ToolCallRow`'s `time`), so it never covers the state. */
export function gutterTime(row: Row): string | undefined {
  if (row.kind === "text" && !row.head) return row.at;
  return undefined;
}

// Shown on hover or focus within the row's own box: the timeline item's `group`, or a nested row's
// `group/call` (so hovering one call never shows its siblings' time).
const TIME_SHOWN = {
  top: "group-focus-within:flex group-hover:flex",
  nested: "group-focus-within/call:flex group-hover/call:flex",
} as const;

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
}) {
  const items = useCallback(() => rowMenuItems(row, slug), [row, slug]);
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
          className={`absolute top-1 right-8 hidden h-6 items-center bg-background px-1 text-[0.8125rem] text-muted-foreground tabular-nums ${nested ? TIME_SHOWN.nested : TIME_SHOWN.top} pointer-coarse:hidden!`}
        >
          {formatTime(time)}
        </time>
      )}
      <RowMenu
        items={items}
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
}: Omit<Parameters<typeof RowChrome>[0], "nested"> & { children: ReactNode }) {
  return (
    <div data-call className="group/call relative -mr-8 pr-8">
      {children}
      <RowChrome {...chrome} nested />
    </div>
  );
}
