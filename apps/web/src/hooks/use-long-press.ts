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

export function useLongPress(onLongPress: (at: { x: number; y: number }) => void) {
  const callback = useRef(onLongPress);
  useEffect(() => {
    callback.current = onLongPress;
  }, [onLongPress]);

  const press = useRef<Press | null>(null);
  const swallowUntil = useRef(0);

  useEffect(() => () => end(press), []);

  return useMemo(
    () => ({
      onPointerDown(e: React.PointerEvent) {
        if (e.pointerType !== "touch") return;
        if (press.current) {
          end(press);
          return;
        }
        swallowUntil.current = 0;
        releaseExpiresAt = 0;
        const el = e.currentTarget;
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
        if (Date.now() >= swallowUntil.current) return;
        swallowUntil.current = 0;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu(e: React.MouseEvent) {
        if (press.current || Date.now() < swallowUntil.current) e.preventDefault();
      },
    }),
    [],
  );
}

function end(ref: React.RefObject<Press | null>) {
  const p = ref.current;
  if (!p) return;
  clearTimeout(p.hold);
  clearTimeout(p.feedback);
  p.el.removeAttribute("data-pressed");
  ref.current = null;
}
