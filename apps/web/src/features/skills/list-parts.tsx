import { type KeyboardEvent, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { onRowKeyDown } from "@/lib/row-nav";
import { runInstantOn } from "@/lib/run-instant";
import { shouldIgnore } from "@/lib/shortcuts";
import type { Arrival } from "@/lib/use-arrival";
import type { PeekControl } from "./use-peek";

/** The row's bar: one 2.75rem row, its facts spaced by `gap-x-4` and wrapping between them. */
export const ROW =
  "of-row flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-left text-sm @min-[60rem]:flex-nowrap @min-[60rem]:py-0";

export const POPUP = { "aria-haspopup": "dialog" } as const;

/** The tint only the arrived row carries; it fades out and `onArrivedEnd` clears it. */
export function arrivalProps(arrival: Arrival | undefined, onArrivedEnd: () => void) {
  return arrival
    ? {
        "data-arrived": arrival === "fading" ? "fading" : "",
        onTransitionEnd: (e: React.TransitionEvent) => {
          if (e.target !== e.currentTarget || arrival !== "fading") return;
          if (e.propertyName && e.propertyName !== "opacity") return;
          onArrivedEnd();
        },
      }
    : {};
}

export type RowProps = {
  selected: boolean;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
};

/** Static skeleton rows at their real height (2.75rem), hoisted so they never re-render. */
export const SKELETON = (
  <div aria-hidden="true" className="border-y border-border">
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="flex h-11 items-center px-2">
        <Skeleton className="h-4 w-48" />
      </div>
    ))}
  </div>
);

/**
 * A list's keys (spec §10.2), by `data-row` and `data-peek-key`: `j`/`k` (the shared `onRowKeyDown`) move between rows
 * and retarget an open peek, Space on the shown row closes it (on another it opens or retargets), F6 moves into the
 * peek. Space acts on keydown and its keyup is cancelled, so it never also clicks.
 */
export function useRowKeys(peek: PeekControl) {
  const list = useRef<HTMLDivElement>(null);
  const rowKeyOf = (el: EventTarget) =>
    el instanceof HTMLElement ? el.dataset.peekKey : undefined;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = onRowKeyDown(e);
    const el = list.current;
    if (!el) return;
    if (row && peek.key !== null && (e.key === "j" || e.key === "k")) {
      const key = row.dataset.peekKey;
      if (key && key !== peek.key) runInstantOn(el, () => peek.show(key));
      return;
    }
    if (e.key === "F6" && peek.key !== null) {
      e.preventDefault();
      peek.focus();
      return;
    }
    const key = e.key === " " ? rowKeyOf(e.target) : undefined;
    if (!key || shouldIgnore(e.nativeEvent)) return;
    e.preventDefault();
    if (peek.key === key) peek.close();
    else runInstantOn(el, () => peek.show(key));
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " && rowKeyOf(e.target)) e.preventDefault();
  };
  return { list, onKeyDown, onKeyUp };
}
