import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Holds a pointer on `el` for `hold` ms under fake timers, then (unless `release` is false) lifts it
 * and sends the click a release produces. Timers are real again afterwards.
 */
export function longPress(
  el: Element,
  {
    x = 10,
    y = 20,
    hold = 500,
    pointerType = "touch",
    release = true,
  }: { x?: number; y?: number; hold?: number; pointerType?: string; release?: boolean } = {},
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
  try {
    const p = { pointerType, clientX: x, clientY: y, pointerId: 1, button: 0 };
    fireEvent.pointerDown(el, p);
    act(() => void vi.advanceTimersByTime(hold));
    if (!release) return;
    fireEvent.pointerUp(el, p);
    fireEvent.click(el, { clientX: x, clientY: y });
  } finally {
    vi.useRealTimers();
  }
}
