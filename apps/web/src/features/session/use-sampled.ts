import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * `value` as shown at most once per `ms` (U3 §5.2, §12): fast live counters (tool-input KB, subagent
 * progress) are read from a ref when the window ends, never set per frame. The first value shows at
 * once; a change waits for the window, then shows the latest. Remount (a new `key`) to start over.
 */
export function useSampled<T>(value: T, ms = 500): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  const stale = !Object.is(shown, value);
  // Re-armed after every show: a change that lands in the same batch as the window's end (still
  // stale, with a new `shown`) gets its own window rather than freezing the counter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` re-arms the window; the timer reads the latest value from the ref
  useEffect(() => {
    if (!stale) return;
    const t = setTimeout(() => setShown(latest.current), ms);
    return () => clearTimeout(t);
  }, [stale, shown, ms]);
  return shown;
}
