import { type FocusEvent, useCallback, useLayoutEffect, useRef, useState } from "react";

export type SetupVisible = {
  /** The steps block is on screen. */
  shown: boolean;
  /** For the list column (the narrow block included): while the pointer or focus is in it, a finished setup does not remove the block. */
  listProps: {
    onPointerEnter(): void;
    onPointerLeave(): void;
    onFocusCapture(e: FocusEvent): void;
    onBlurCapture(e: FocusEvent): void;
    /** Leaving the DOM is leaving: no pointerleave or blur fires then, so this resets what they track. */
    ref(el: HTMLElement | null): void;
  };
  /** For the block: where focus is, so it can be moved before the block goes. */
  blockProps: {
    onFocusCapture(): void;
    onBlurCapture(e: FocusEvent): void;
    ref(el: HTMLElement | null): void;
  };
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
  const block = useRef<HTMLElement | null>(null);
  if (prev !== hasAgent) {
    setPrev(hasAgent);
    if (prev === false && hasAgent && (pointer.current || focus.current)) setHeld(true);
  }
  const shown = hasAgent === false || held;

  // After every commit: with the block gone and focus having been in it, that focus is lost. If the block left
  // because setup finished, move it to the first Inbox row (or the heading) before paint; if it left for
  // another reason (the pane now shows an item) just forget it, or a later finish would steal focus.
  useLayoutEffect(() => {
    if (block.current || !focusInside.current) return;
    focusInside.current = false;
    if (shown) return;
    const row = document.querySelector<HTMLElement>("a[data-inbox-id]");
    const heading = document.querySelector<HTMLElement>("h1");
    if (heading && !row) heading.tabIndex = -1;
    (row ?? heading)?.focus();
  });

  const listRef = useCallback((el: HTMLElement | null) => {
    if (el) return;
    pointer.current = false;
    focus.current = false;
    setHeld(false);
  }, []);
  const blockRef = useCallback((el: HTMLElement | null) => {
    block.current = el;
  }, []);

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
      onFocusCapture(e) {
        // Below 1024 the block sits inside the list column: focus on a step is not focus on the list.
        if (block.current?.contains(e.target as Node)) return;
        focus.current = true;
      },
      onBlurCapture(e) {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focus.current = false;
        leave();
      },
      ref: listRef,
    },
    blockProps: {
      ref: blockRef,
      onFocusCapture() {
        focusInside.current = true;
      },
      onBlurCapture(e) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInside.current = false;
      },
    },
  };
}
