/** A keyboard-triggered transition (⌘B): suspend transitions and animations for the frame that applies it. */
export function runInstant(fn: () => void) {
  const root = document.documentElement;
  root.dataset.instant = "";
  try {
    fn();
  } finally {
    // Cleared even if fn throws, or the root would stay instant (no transitions) for good.
    requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant));
  }
}
