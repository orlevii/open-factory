import { memo, useEffect, useRef, useState } from "react";
import { formatDuration } from "@/features/session/format";
import { useDocumentVisible } from "@/hooks/use-document-visible";

/** Time elapsed since `since`, ticking on whole seconds; paused while the tab is hidden and recomputed
 *  at once when it returns (or `since` changes), never as a second render on mount. Its own state, so
 *  nothing else re-renders per tick. An unparseable `since` renders nothing (never "NaNs"). With
 *  `hideUnderMs` it renders nothing until that much time has passed, and its first tick is at that point
 *  (a row that has just started shows no clock). */
export const Elapsed = memo(function Elapsed({
  since,
  hideUnderMs = 0,
}: {
  since: string;
  hideUnderMs?: number;
}) {
  const visible = useDocumentVisible();
  const start = Date.parse(since);
  const valid = !Number.isNaN(start);
  const [now, setNow] = useState(Date.now);
  // What the state was last computed for: the mount's initial state already is, so no catch-up render.
  const synced = useRef({ visible, start });
  useEffect(() => {
    if (!visible || !valid) {
      synced.current.visible = visible;
      return;
    }
    if (synced.current.visible !== visible || synced.current.start !== start) setNow(Date.now());
    synced.current = { visible, start };
    let timer: ReturnType<typeof setTimeout>;
    const wait = (t: number) => {
      const elapsed = Math.max(0, t - start);
      return elapsed < hideUnderMs ? hideUnderMs - elapsed : 1000 - (elapsed % 1000);
    };
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(tick, wait(t));
    };
    timer = setTimeout(tick, wait(Date.now()));
    return () => clearTimeout(timer);
  }, [visible, start, valid, hideUnderMs]);
  if (!valid || now - start < hideUnderMs) return null;
  return <span className="shrink-0 tabular-nums">{formatDuration(now - start)}</span>;
});
