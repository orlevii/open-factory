import type { FocusEvent, KeyboardEvent } from "react";
import { shouldIgnore } from "./shortcuts";

const KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/** Arrow keys, Home and End also move between the rows of a list, anchors and buttons alike, found by their
 *  `data-row` attribute (`j`/`k` too, unless single-key shortcuts are off or the press belongs to a field or
 *  modal); Tab still reaches every row. Returns the row that took focus. */
export function onRowKeyDown(e: KeyboardEvent<HTMLElement>): HTMLElement | undefined {
  const vim = (e.key === "j" || e.key === "k") && !shouldIgnore(e.nativeEvent);
  if (!(vim || KEYS.includes(e.key)) || !(e.target instanceof HTMLElement)) return;
  if (!e.target.hasAttribute("data-row")) return;
  const links = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
  const i = links.indexOf(e.target);
  const down = e.key === "ArrowDown" || e.key === "j";
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? links.length - 1
        : Math.min(links.length - 1, Math.max(0, i + (down ? 1 : -1)));
  e.preventDefault();
  links[next]?.focus();
  return links[next];
}

/** A row link's `onFocus`: keeps its intent preload for hover only. Row navigation focuses row by
 *  row, and a focus preload would run the target's loader for every row a sweep passes. The
 *  router's Link skips its own focus handler when ours prevents the default (`composeHandlers`). */
export function skipFocusPreload(e: FocusEvent<HTMLElement>) {
  e.preventDefault();
}
