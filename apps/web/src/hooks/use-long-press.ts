import type * as React from "react";
import { useEffect, useMemo, useRef } from "react";

const HOLD_MS = 500;
const FEEDBACK_MS = 80;
const SLOP_PX = 8;

let releaseMarked = false;

/** True for one pointerup after a long-press fired: menus call it to ignore the lifting finger. */
export function consumeLongPressRelease(): boolean {
  const marked = releaseMarked;
  releaseMarked = false;
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
  const swallowClick = useRef(false);

  useEffect(() => () => end(press), []);

  return useMemo(
    () => ({
      onPointerDown(e: React.PointerEvent) {
        if (e.pointerType !== "touch") return;
        if (press.current) {
          end(press);
          return;
        }
        swallowClick.current = false;
        const el = e.currentTarget;
        const at = { x: e.clientX, y: e.clientY };
        const hold = setTimeout(() => {
          end(press);
          swallowClick.current = true;
          releaseMarked = true;
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
        if (press.current && e.pointerId === press.current.pointerId) end(press);
      },
      onPointerCancel(e: React.PointerEvent) {
        if (press.current && e.pointerId === press.current.pointerId) end(press);
      },
      onClickCapture(e: React.MouseEvent) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu(e: React.MouseEvent) {
        if (press.current || swallowClick.current) e.preventDefault();
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
