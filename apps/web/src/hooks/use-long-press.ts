import type * as React from "react";
import { useEffect, useMemo, useRef } from "react";

const HOLD_MS = 500;
const FEEDBACK_MS = 80;
const SLOP_PX = 8;

// While the finger is still down after a fire the marks stay valid this long; once it lifts they
// expire RELEASE_GRACE_MS later, so a stale mark never swallows a later, unrelated event.
const HELD_GRACE_MS = 10_000;
const RELEASE_GRACE_MS = 1000;

let releaseExpiresAt = 0;

/** True for one pointerup after a long-press fired: menus call it to ignore the lifting finger. */
export function consumeLongPressRelease(): boolean {
  const marked = Date.now() < releaseExpiresAt;
  releaseExpiresAt = 0;
  return marked;
}

type Press = {
  pointerId: number;
  x: number;
  y: number;
  el: Element;
  hold: ReturnType<typeof setTimeout>;
  feedback: ReturnType<typeof setTimeout>;
};

/** Which element a touch press on `e.currentTarget` presses (it takes `data-pressed`), or null when the
 *  press started somewhere that isn't a long-press region (prose, a field). Read only on pointerdown. */
export type PickPressed = (e: React.PointerEvent) => Element | null;

export function useLongPress(
  onLongPress: (at: { x: number; y: number }) => void,
  { pick }: { pick?: PickPressed } = {},
) {
  const callback = useRef(onLongPress);
  const picker = useRef(pick);
  useEffect(() => {
    callback.current = onLongPress;
    picker.current = pick;
  }, [onLongPress, pick]);

  const press = useRef<Press | null>(null);
  const swallowUntil = useRef(0);

  useEffect(() => () => end(press), []);

  return useMemo(
    () => ({
      onPointerDown(e: React.PointerEvent) {
        if (e.pointerType !== "touch" || !inside(e)) return;
        if (press.current) {
          end(press);
          return;
        }
        const el = picker.current ? picker.current(e) : e.currentTarget;
        if (!el) return;
        swallowUntil.current = 0;
        releaseExpiresAt = 0;
        const at = { x: e.clientX, y: e.clientY };
        const hold = setTimeout(() => {
          end(press);
          swallowUntil.current = Date.now() + HELD_GRACE_MS;
          releaseExpiresAt = swallowUntil.current;
          navigator.vibrate?.(10);
          callback.current(at);
        }, HOLD_MS);
        const feedback = setTimeout(() => el.setAttribute("data-pressed", ""), FEEDBACK_MS);
        press.current = { pointerId: e.pointerId, ...at, el, hold, feedback };
      },
      onPointerMove(e: React.PointerEvent) {
        const p = press.current;
        if (!p || e.pointerId !== p.pointerId) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) end(press);
      },
      onPointerUp(e: React.PointerEvent) {
        if (press.current && e.pointerId === press.current.pointerId) {
          end(press);
        } else if (e.pointerType === "touch" && Date.now() < swallowUntil.current) {
          // The finger that fired the press is lifting: start the grace window.
          swallowUntil.current = Date.now() + RELEASE_GRACE_MS;
          releaseExpiresAt = swallowUntil.current;
        }
      },
      onPointerCancel(e: React.PointerEvent) {
        if (press.current && e.pointerId === press.current.pointerId) end(press);
      },
      onClickCapture(e: React.MouseEvent) {
        if (Date.now() >= swallowUntil.current || !inside(e)) return;
        swallowUntil.current = 0;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu(e: React.MouseEvent) {
        if (!inside(e)) return;
        if (press.current || Date.now() < swallowUntil.current) e.preventDefault();
      },
    }),
    [],
  );
}

/** The event happened in the element's own DOM, not in a portal of its React tree (a menu it opened):
 *  a tap on a drawer item is never swallowed, and holding one never presses the row behind it. */
function inside(e: React.SyntheticEvent) {
  return e.target instanceof Node && e.currentTarget.contains(e.target);
}

function end(ref: React.RefObject<Press | null>) {
  const p = ref.current;
  if (!p) return;
  clearTimeout(p.hold);
  clearTimeout(p.feedback);
  p.el.removeAttribute("data-pressed");
  ref.current = null;
}
