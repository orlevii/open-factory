import { useEffect, useRef, useState } from "react";
import type { WsStatus } from "./ws";

/** Grace periods before a non-open socket counts as "lost" (UI design §5.5). */
export const LOST_AFTER_MS = 3_000; // after the socket has been open at least once
export const FIRST_CONNECT_GRACE_MS = 5_000; // on the very first connect

/** True while the socket has been away from "open" longer than the grace period. Short blips never
 *  show. The clock runs from the moment the socket left "open", so the connecting/closed flips of
 *  a reconnect loop don't restart it. */
export function useConnectionLost(status: WsStatus): boolean {
  const isOpen = status === "open";
  const everOpen = useRef(false);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (isOpen) {
      everOpen.current = true;
      setLost(false);
      return;
    }
    const timer = setTimeout(
      () => setLost(true),
      everOpen.current ? LOST_AFTER_MS : FIRST_CONNECT_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [isOpen]);
  return lost;
}
