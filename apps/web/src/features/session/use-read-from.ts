import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { postReadFrom, useInboxCache, useUnreadByAgent } from "@/features/inbox/api";

/** At most one read-from per second. */
const MIN_GAP_MS = 1000;

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const isVisible = () => document.visibilityState !== "hidden";

type Pending = { agentRef: string; upTo: string };

/**
 * Viewing a session or a chat marks that agent's messages to the viewer read (spec §2.3, I1 §6.7). Runs
 * only from this effect, never a loader, so a hover preload of the route cannot mark anything. A visible
 * tab with unread messages posts `upTo` = the newest time shown; the unread count turns to zero at once.
 * It posts on mount and again only when something newer than the last `upTo` it posted arrives, never
 * because the count went up again by itself (an Undo of Mark all read must stick while this is open).
 * `delayMs` waits that long first (the Inbox pane's dwell), and moving to another agent cancels it. One
 * request in flight, a trailing 1s throttle, and a failure refetches the count and the inbox, which
 * are the truth, and is not retried until a newer time, another agent or the tab coming back.
 */
export function useReadFrom(
  agentRef: string,
  newestAt: string | undefined,
  { delayMs = 0 }: { delayMs?: number } = {},
): void {
  const hasUnread = useUnreadByAgent(agentRef) > 0;
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => true);
  const cache = useInboxCache();
  const state = useRef({
    inFlight: false,
    lastAt: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pending: undefined as Pending | undefined,
    /** The call that last failed: not repeated until the newest event or the agentRef changes, or the tab returns. */
    failed: undefined as Pending | undefined,
    /** The newest time a call has been made for, for this agent. */
    upTo: undefined as string | undefined,
    /** The time a dwell is waiting to post: if the unread clears meanwhile (Mark all read), it counts as covered. */
    armed: undefined as string | undefined,
  });

  const request = useCallback(
    (want: Pending) => {
      const st = state.current;
      if (st.failed?.agentRef === want.agentRef && st.failed.upTo === want.upTo) return;
      st.pending = want;
      if (st.inFlight || st.timer !== undefined) return;
      const flush = () => {
        st.timer = undefined;
        const next = st.pending;
        if (!next || st.inFlight) return;
        st.pending = undefined;
        // A trailing call that fires after the tab was hidden waits for it to be visible again.
        if (!isVisible()) return;
        st.inFlight = true;
        st.lastAt = Date.now();
        st.upTo = next.upTo;
        cache.readFrom(next.agentRef);
        postReadFrom(next.agentRef, next.upTo)
          .catch(() => {
            st.failed = next;
            st.upTo = undefined;
            cache.refetch();
          })
          .finally(() => {
            st.inFlight = false;
            if (st.pending) request(st.pending);
          });
      };
      const wait = st.lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) st.timer = setTimeout(flush, wait);
      else flush();
    },
    [cache],
  );

  useEffect(() => {
    const st = state.current;
    if (!visible) st.failed = undefined;
    if (!hasUnread) {
      // Cleared while a dwell was waiting: that time is covered, so an Undo cannot make the pane read it again.
      if (st.armed !== undefined && (st.upTo === undefined || st.armed > st.upTo))
        st.upTo = st.armed;
      st.armed = undefined;
      return;
    }
    if (!visible || !newestAt) return;
    // Nothing newer than what was already posted: the count rising again is not a reason.
    if (st.upTo !== undefined && newestAt <= st.upTo) return;
    const post = () => {
      st.armed = undefined;
      request({ agentRef, upTo: newestAt });
    };
    if (delayMs <= 0) return post();
    st.armed = newestAt;
    const timer = setTimeout(post, delayMs);
    return () => clearTimeout(timer);
  }, [agentRef, hasUnread, newestAt, visible, delayMs, request]);

  // Another agent's session, or leaving: the trailing call for this one is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentRef is the trigger, not a read
  useEffect(
    () => () => {
      const st = state.current;
      clearTimeout(st.timer);
      st.timer = undefined;
      st.pending = undefined;
      st.upTo = undefined;
      st.armed = undefined;
    },
    [agentRef],
  );
}
