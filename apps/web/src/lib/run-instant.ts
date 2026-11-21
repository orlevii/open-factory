/** A keyboard-triggered transition (⌘B): suspend transitions and animations for the frame that applies it. */
export function runInstant(fn: () => void) {
  const root = document.documentElement;
  root.dataset.instant = "";
  fn();
  requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.instant));
}
