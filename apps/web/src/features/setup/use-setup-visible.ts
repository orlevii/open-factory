import { type FocusEvent, useLayoutEffect, useRef, useState } from "react";

export type SetupVisible = {
  /** The steps block is on screen. */
  shown: boolean;
  /** For the list column: while the pointer or focus is in it, a finished setup does not remove the block. */
  listProps: {
    onPointerEnter(): void;
    onPointerLeave(): void;
    onFocusCapture(): void;
    onBlurCapture(e: FocusEvent): void;
  };
  /** For the block: where focus is, so it can be moved before the block goes. */
  blockProps: { onFocusCapture(): void; onBlurCapture(e: FocusEvent): void };
};

/**
 * Whether the first-run steps show (I8 §4.2): while no agent exists. When one appears the block leaves in
 * that same render, unless the pointer or focus is in the list column: then it waits until both have left
 * (I1's list-stability rule) and goes at once. Focus inside the block does not hold it; it moves to the
 * first Inbox row, or the page heading when the Inbox is empty, before the next paint.
 *
 * Where the pointer and focus are lives in refs; the only state is `held`, set during render on the change.
 */
export function useSetupVisible(hasAgent: boolean | undefined): SetupVisible {
  const [held, setHeld] = useState(false);
  const [prev, setPrev] = useState(hasAgent);
  const pointer = useRef(false);
  const focus = useRef(false);
  const focusInside = useRef(false);
  if (prev !== hasAgent) {
    setPrev(hasAgent);
    if (prev === false && hasAgent && (pointer.current || focus.current)) setHeld(true);
  }
  const shown = hasAgent === false || held;

  useLayoutEffect(() => {
    if (shown || !focusInside.current) return;
    focusInside.current = false;
    const row = document.querySelector<HTMLElement>("a[data-inbox-id]");
    const heading = document.querySelector<HTMLElement>("h1");
    if (heading && !row) heading.tabIndex = -1;
    (row ?? heading)?.focus();
  }, [shown]);

  const leave = () => {
    if (!pointer.current && !focus.current) setHeld(false);
  };
  return {
    shown,
    listProps: {
      onPointerEnter() {
        pointer.current = true;
      },
      onPointerLeave() {
        pointer.current = false;
        leave();
      },
      onFocusCapture() {
        focus.current = true;
      },
      onBlurCapture(e) {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focus.current = false;
        leave();
      },
    },
    blockProps: {
      onFocusCapture() {
        focusInside.current = true;
      },
      onBlurCapture(e) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInside.current = false;
      },
    },
  };
}
