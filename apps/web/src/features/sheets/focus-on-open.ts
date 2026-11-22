import { type RefObject, useEffect } from "react";

const FIELD =
  'input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button[role=combobox]:not(:disabled), [contenteditable="true"]';

/**
 * Focus-on-open (spec §5.3, §8): when a sheet body mounts on desktop, its first field takes focus, unless focus is
 * already on something inside the sheet other than the panel itself. Phones keep focus on the drawer content, so the
 * keyboard doesn't rise mid-slide (U1 rule). `selector` overrides what counts as the first target.
 */
export function useFocusOnOpen(ref: RefObject<HTMLElement | null>, selector = FIELD) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the body mounts
  useEffect(() => {
    const root = ref.current;
    const sheet = root?.closest<HTMLElement>("[data-slot=sheet-content]");
    if (!root || !sheet) return;
    const at = document.activeElement;
    if (at && at !== sheet && sheet.contains(at)) return;
    root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, []);
}
