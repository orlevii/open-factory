import { act } from "@testing-library/react";

/** Ends the element's CSS exit animation, as a browser would: jsdom never fires `animationend`, and a
 *  closing Vaul drawer (and its focus return) waits for it. */
export function endAnimation(el: Element) {
  const end = new Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: getComputedStyle(el).animationName });
  act(() => {
    el.dispatchEvent(end);
  });
}
