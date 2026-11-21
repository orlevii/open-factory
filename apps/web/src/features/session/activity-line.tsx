import { memo, useEffect, useState } from "react";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { formatDuration } from "./format";

/** Time elapsed since `since`, ticking on whole seconds; paused while the tab is hidden and recomputed
 *  at once when it returns. Its own state, so nothing else re-renders per tick. */
export const Elapsed = memo(function Elapsed({ since }: { since: string }) {
  const visible = useDocumentVisible();
  const start = Date.parse(since);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(tick, 1000 - (Math.max(0, t - start) % 1000));
    };
    const t0 = Date.now();
    timer = setTimeout(tick, 1000 - (Math.max(0, t0 - start) % 1000));
    return () => clearTimeout(timer);
  }, [visible, start]);
  return <span className="shrink-0 tabular-nums">{formatDuration(now - start)}</span>;
});
