import { useSyncExternalStore } from "react";
import { MOBILE_QUERY } from "@/hooks/use-mobile";

/** Below md. rem, so every breakpoint follows the browser's text size. */
export const MOBILE = MOBILE_QUERY;
/** Inbox panes and the in-flow Agent details. */
export const WIDE = "(width >= 64rem)";
/** Agent details open by default. */
export const XWIDE = "(width >= 80rem)";

/** One MediaQueryList per query, per matchMedia function (tests install a fresh fake per test). */
let lists = {
  fn: undefined as typeof window.matchMedia | undefined,
  map: new Map<string, MediaQueryList>(),
};
function mql(query: string): MediaQueryList {
  if (lists.fn !== window.matchMedia) lists = { fn: window.matchMedia, map: new Map() };
  let m = lists.map.get(query);
  if (!m) {
    m = window.matchMedia(query);
    lists.map.set(query, m);
  }
  return m;
}

const getServerSnapshot = () => false;

/** Whether the viewport matches `query`. Correct on the first render and live afterwards. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = mql(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => mql(query).matches,
    getServerSnapshot,
  );
}
