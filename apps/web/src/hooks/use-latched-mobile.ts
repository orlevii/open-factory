import { useState } from "react";
import { isMobileNow } from "./use-mobile";

/** Dialog or drawer is decided when an overlay opens and kept until it closes (spec §5.1): a resize or
 *  rotation never swaps the primitive under a pending request or a draft. */
export function useLatchedMobile(open: boolean): boolean {
  const [prevOpen, setPrevOpen] = useState(open);
  const [latched, setLatched] = useState(isMobileNow);
  // Read the media query only on the closed → open edge, not by subscribing, so a closed overlay never
  // re-renders on a resize. State adjusted on a prop edge during render (no effect).
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setLatched(isMobileNow());
  }
  // Kept after close too, so the exit animation plays on the primitive that opened.
  return latched;
}
