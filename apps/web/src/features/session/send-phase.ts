import { useEffect, useState } from "react";

/** U3 §13.2: "Sending…" only when the POST is slow (no flash under this). */
export const SLOW_SEND_MS = 400;
/** What a send became (a queue item, a row) stays `young` (no "Not delivered yet", no "Runs after…")
 *  until this long after it was sent. */
export const YOUNG_ITEM_MS = 300;

/**
 * The timing of one outgoing block, kept in the component that holds the node across its states
 * (sending, queued, delivered). It starts `sending` when mounted from a send; a block that was never a
 * send on this screen is never young. `slow` is a send still in flight after `SLOW_SEND_MS`.
 */
export function useSendPhase(sending: boolean): { young: boolean; slow: boolean } {
  const [sentAt] = useState(() => (sending ? Date.now() : undefined));
  const [slow, setSlow] = useState(false);
  const [grown, setGrown] = useState(sentAt === undefined);
  useEffect(() => {
    if (!sending) return;
    const t = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => clearTimeout(t);
  }, [sending]);
  useEffect(() => {
    if (sending || grown || sentAt === undefined) return;
    const t = setTimeout(() => setGrown(true), Math.max(0, sentAt + YOUNG_ITEM_MS - Date.now()));
    return () => clearTimeout(t);
  }, [sending, grown, sentAt]);
  return { young: !grown, slow: sending && slow };
}
