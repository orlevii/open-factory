/** A keyboard-triggered transition (⌘B): suspend transitions and animations for the frame that applies it. */
export function runInstant(fn: () => void) {
  runInstantOn(document.documentElement, fn);
}

/** Like `runInstant`, scoped to one element (a row's selected background), so the rest of the page keeps animating. */
export function runInstantOn(el: HTMLElement, fn: () => void) {
  el.dataset.instant = "";
  try {
    fn();
  } finally {
    // Cleared even if fn throws, or the element would stay instant (no transitions) for good.
    requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.instant));
  }
}
