import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentVisible } from "@/hooks/use-document-visible";

/** Visible time the deep-link tint holds before it fades (U3 §7.4, Q28). */
export const ARRIVAL_MS = 2000;
export type Arrival = "on" | "fading";

/** Focuses a deep-linked row without scrolling again. A programmatic focus after a mouse navigation
 *  may not match `:focus-visible`; the row then carries `data-focus-ring`, styled the same, until it
 *  loses focus ("ring = focus"). */
export function arrive(row: HTMLElement) {
  row.focus({ preventScroll: true });
  let visible = false;
  try {
    visible = row.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible: the stand-in ring.
  }
  if (visible) return;
  row.setAttribute("data-focus-ring", "");
  row.addEventListener("blur", () => row.removeAttribute("data-focus-ring"), { once: true });
}

/** The tint: "on" for ARRIVAL_MS of visible time, then "fading" until the row's transitionend calls
 *  onArrivedEnd. `start` and `onArrivedEnd` are stable: they go into memoised rows. */
export function useArrivalTint() {
  const [arrival, setArrival] = useState<Arrival>();
  const visible = useDocumentVisible();
  const left = useRef(ARRIVAL_MS);
  // The tint fades after 2s of visible time (U3 §7.4): hidden, the clock stops and keeps what's left.
  // An effect runs after the row painted, so the 2s start from the first frame that shows it.
  useEffect(() => {
    if (arrival !== "on" || !visible) return;
    const startedAt = Date.now();
    const t = setTimeout(() => setArrival("fading"), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - startedAt));
    };
  }, [arrival, visible]);
  const start = useCallback(() => {
    left.current = ARRIVAL_MS;
    setArrival("on");
  }, []);
  const onArrivedEnd = useCallback(() => setArrival(undefined), []);
  return { arrival, start, onArrivedEnd };
}
