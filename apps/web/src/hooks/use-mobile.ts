import { useSyncExternalStore } from "react";

/** Below md (48rem): the same breakpoint as the desktop sidebar, in rem so it follows the browser's text size. */
export const MOBILE_QUERY = "(width < 48rem)";

let cached: { fn: typeof window.matchMedia; mql: MediaQueryList } | undefined;
/** One MediaQueryList per matchMedia function (tests install a fresh fake per test). */
function mql(): MediaQueryList {
  if (cached?.fn !== window.matchMedia)
    cached = { fn: window.matchMedia, mql: window.matchMedia(MOBILE_QUERY) };
  return cached.mql;
}

function subscribe(onChange: () => void) {
  const m = mql();
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

const getSnapshot = () => mql().matches;
const getServerSnapshot = () => false;

/** A plain read of the cached list, for open-edge checks outside React. */
export const isMobileNow = getSnapshot;

/** Whether the viewport is phone-sized. Correct on the first render, so phones never paint the desktop layout. */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
