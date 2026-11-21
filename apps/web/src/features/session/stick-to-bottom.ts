import { type RefObject, useEffect, useMemo, useRef } from "react";

/** Within this many px of the bottom counts as at the bottom (U3 §8.1). */
const SLACK = 8;
/** Keys in the log that read as "I want to look up". */
const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
/** A user-initiated expand, collapse or "Show all" inside the log; menu triggers aren't toggles. */
const TOGGLE = ":is([aria-expanded], summary, [data-expands]):not([aria-haspopup])";
const PASSIVE = { passive: true } as const;

export type StickToBottom = {
  /** Whether the view follows new content. A ref: it changes on scroll, not on render. */
  pinned: RefObject<boolean>;
  /** Scrolls to the bottom and follows again (Jump, End, sending from the composer). */
  repin(): void;
  /** Stops following and keeps the top visible row in place (deep-link centring). */
  unpin(): void;
  /** Unpins and keeps `el`'s top where it is through the coming height change: a toggle calls it
   *  before its state change. Without `el`, anchors the top visible row (Load earlier). */
  expandAnchor(el?: HTMLElement): void;
  /** Takes a fresh anchor on the top visible row (a column's width is about to change). */
  captureAnchor(): void;
  /** After a commit that may have changed the height: pinned writes the bottom, unpinned keeps the
   *  anchor in place. Call from a layout effect, so it lands before paint. */
  settle(): void;
};

/**
 * Stick-to-bottom on intent (U3 §8.1): the view unpins only when the reader shows they want to look
 * up (wheel, touch, keys, a selection, a scroll we didn't write) and never because content grew.
 * Every height change while unpinned keeps an anchor row in place instead of relying on
 * `overflow-anchor`. `pinned` lives in a ref; `onPinChange` fires only on the edges. Returns one
 * stable object whose methods read refs.
 */
export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  log: RefObject<HTMLElement | null>,
  onPinChange?: (pinned: boolean) => void,
): StickToBottom {
  const pinned = useRef(true);
  const onChange = useRef(onPinChange);
  onChange.current = onPinChange;
  const m = useRef({
    /** The scrollTop our own code last wrote, so its scroll event isn't read as the reader's. */
    lastWrittenTop: undefined as number | undefined,
    /** Position and scrollHeight at the last scroll event (or our last write, for the position). */
    lastTop: 0,
    heightAtLastScroll: 0,
    anchor: null as { el: HTMLElement; top: number } | null,
    frame: 0,
    /** A selection inside the log unpinned the view: its collapse may re-pin. */
    selecting: false,
    touchY: undefined as number | undefined,
  }).current;

  const api = useMemo<StickToBottom>(() => {
    const write = (sc: HTMLElement, top: number) => {
      sc.scrollTop = top;
      m.lastWrittenTop = sc.scrollTop; // the browser clamps it
      m.lastTop = sc.scrollTop;
    };
    const toBottom = () => {
      const sc = scroller.current;
      if (sc) write(sc, sc.scrollHeight);
    };
    const captureAnchor = () => {
      const sc = scroller.current;
      if (!sc) return;
      const box = sc.getBoundingClientRect();
      const hit = document
        .elementFromPoint?.(box.left + 32, box.top + 1)
        ?.closest<HTMLElement>("[data-row]");
      // The point can land in the space between rows: take the first row that reaches the top.
      const row =
        hit && sc.contains(hit)
          ? hit
          : [...sc.querySelectorAll<HTMLElement>("[data-row]")].find(
              (r) => r.getBoundingClientRect().bottom > box.top,
            );
      // A probe that finds nothing keeps the last good anchor rather than clearing it.
      if (row) m.anchor = { el: row, top: row.getBoundingClientRect().top };
    };
    const setPinned = (next: boolean) => {
      if (pinned.current === next) return;
      pinned.current = next;
      onChange.current?.(next);
    };
    const restore = () => {
      const sc = scroller.current;
      const a = m.anchor;
      if (!sc || !a?.el.isConnected) return;
      const delta = a.el.getBoundingClientRect().top - a.top;
      if (!delta) return;
      write(sc, sc.scrollTop + delta);
      // Where it really sits now (the write may have clamped), so a repeat call doesn't add again.
      a.top = a.el.getBoundingClientRect().top;
    };
    return {
      pinned,
      captureAnchor,
      repin() {
        setPinned(true);
        toBottom();
      },
      unpin() {
        if (pinned.current) captureAnchor();
        setPinned(false);
      },
      expandAnchor(el) {
        if (el) m.anchor = { el, top: el.getBoundingClientRect().top };
        else captureAnchor();
        setPinned(false);
      },
      settle() {
        if (pinned.current) toBottom();
        else restore();
      },
    };
    // Refs only: the object is created once.
  }, [scroller, m]);

  useEffect(() => {
    const sc = scroller.current;
    const content = log.current;
    if (!sc || !content) return;
    const unpin = api.unpin;
    const gap = (height: number) => height - sc.scrollTop - sc.clientHeight;

    const onScroll = () => {
      const top = sc.scrollTop;
      const height = sc.scrollHeight;
      const prevTop = m.lastTop;
      const prevHeight = m.heightAtLastScroll || height;
      m.lastTop = top;
      m.heightAtLastScroll = height;
      const ours = m.lastWrittenTop !== undefined && Math.abs(top - m.lastWrittenTop) < 1;
      if (!ours) {
        // The anchor moved with the reader's scroll: keep it true until the next probe.
        if (m.anchor) m.anchor.top -= top - prevTop;
        if (pinned.current) {
          // Fallback (scrollbar drag, find in page): up, and now away from the bottom. A shrink
          // clamps scrollTop down but leaves the view at the bottom, so it stays pinned.
          if (top < prevTop && gap(height) > SLACK) unpin();
        } else if (top > prevTop && gap(Math.min(prevHeight, height)) <= SLACK) api.repin();
      }
      if (!pinned.current && !m.frame)
        m.frame = requestAnimationFrame(() => {
          m.frame = 0;
          api.captureAnchor();
        });
    };

    /** A nested scroller (code plate, table) under the pointer that can still scroll up takes it. */
    const absorbed = (target: EventTarget | null) => {
      for (let n = target instanceof Element ? target : null; n && n !== sc; n = n.parentElement) {
        if (n.scrollTop <= 0 || n.scrollHeight <= n.clientHeight) continue;
        const overflow = getComputedStyle(n).overflowY;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !absorbed(e.target)) unpin();
    };
    const onTouchStart = (e: TouchEvent) => {
      m.touchY = e.touches[0]?.clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      // The finger moving down scrolls the content up.
      if (y !== undefined && m.touchY !== undefined && y > m.touchY && !absorbed(e.target)) unpin();
      m.touchY = y;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) unpin();
    };
    // Focus entering a row above the viewport (Tab into the log, roving focus) is a look-up intent.
    const onFocusIn = (e: FocusEvent) => {
      const row = (e.target as Element | null)?.closest?.("[data-row]");
      if (row && row.getBoundingClientRect().top < sc.getBoundingClientRect().top) unpin();
    };
    // Capture: runs before React's handlers, so the anchor is taken before the state change.
    const onClick = (e: MouseEvent) => {
      const toggle = (e.target as Element | null)?.closest?.<HTMLElement>(TOGGLE);
      if (!toggle || !content.contains(toggle)) return;
      // "Show all" unmounts itself: its row's top stands in for it.
      const el = toggle.matches("[data-expands]")
        ? (toggle.closest<HTMLElement>("[data-row]") ?? toggle)
        : toggle;
      api.expandAnchor(el);
    };
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && content.contains(sel.anchorNode)) {
        m.selecting = true;
        unpin();
      } else if (m.selecting && (!sel || sel.isCollapsed)) {
        m.selecting = false;
        if (gap(sc.scrollHeight) <= SLACK) api.repin();
      }
    };

    sc.addEventListener("scroll", onScroll, PASSIVE);
    sc.addEventListener("wheel", onWheel, PASSIVE);
    sc.addEventListener("touchstart", onTouchStart, PASSIVE);
    sc.addEventListener("touchmove", onTouchMove, PASSIVE);
    content.addEventListener("keydown", onKeyDown, PASSIVE);
    content.addEventListener("focusin", onFocusIn, PASSIVE);
    content.addEventListener("click", onClick, { capture: true, passive: true });
    document.addEventListener("selectionchange", onSelectionChange, PASSIVE);
    // Footer and async content (queued blocks, the activity line, "Show all", a width change from
    // the sidebar or Agent details) change the height without a rows commit. Synchronous: after
    // layout, before paint.
    const ro =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => api.settle());
    ro?.observe(content);
    ro?.observe(sc);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("touchstart", onTouchStart);
      sc.removeEventListener("touchmove", onTouchMove);
      content.removeEventListener("keydown", onKeyDown);
      content.removeEventListener("focusin", onFocusIn);
      content.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("selectionchange", onSelectionChange);
      ro?.disconnect();
      cancelAnimationFrame(m.frame);
      m.frame = 0;
    };
  }, [scroller, log, api, m]);

  return api;
}
