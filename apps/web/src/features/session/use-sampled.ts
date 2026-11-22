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
  useEffect(() => {
    if (!stale) return;
    const t = setTimeout(() => setShown(latest.current), ms);
    return () => clearTimeout(t);
  }, [stale, ms]);
  return shown;
}
