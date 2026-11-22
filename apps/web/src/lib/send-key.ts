let coarseCache: { fn: typeof window.matchMedia; mql: MediaQueryList } | undefined;
/** One cached MediaQueryList per matchMedia function (tests install fresh fakes), not one per keystroke. */
export const isCoarsePointer = () => {
  if (typeof window.matchMedia !== "function") return false;
  if (coarseCache?.fn !== window.matchMedia)
    coarseCache = { fn: window.matchMedia, mql: window.matchMedia("(pointer: coarse)") };
  return coarseCache.mql.matches;
};

/** Enter sends everywhere; Shift+Enter adds a line; ⌘/Ctrl+Enter also sends; on touch, plain Enter adds a line;
 *  an IME-confirming Enter never sends (Safari fires it as keyCode 229). DESIGN.md → Composers. */
export function isSendKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "keyCode" | "isComposing">,
  coarse = isCoarsePointer(),
): boolean {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !e.shiftKey && !coarse;
}

/** ⌥/Alt+Enter sends with `urgent: true` (U3 §6.2): fine pointers only, never while composing. `isSendKey` also
 *  matches it, so a key handler checks this first. */
export function isUrgentSendKey(
  e: Pick<
    KeyboardEvent,
    "key" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey" | "keyCode" | "isComposing"
  >,
  coarse = isCoarsePointer(),
): boolean {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return false;
  return e.altKey && !coarse;
}
