import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { postReadFrom, useInboxCache, useUnreadByAgent } from "@/features/inbox/api";

/** At most one read-from per second. */
const MIN_GAP_MS = 1000;

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const isVisible = () => document.visibilityState !== "hidden";

type Pending = { slug: string; upTo: string };

/**
 * Viewing a session marks that agent's messages to the viewer read (spec §2.3). Runs only from this
 * effect, never a loader, so a hover preload of the route cannot mark anything. A visible tab with
 * unread messages posts `upTo` = the newest event time; the unread count turns to zero at once, and
 * while it is still > 0 (a new message after the last call) a newer event posts again. One request
 * in flight, a trailing 1s throttle, and a failure refetches the count and the inbox, which are the
 * truth, and is not retried until a newer event, another session or the tab coming back.
 */
export function useReadFrom(slug: string, newestEventAt: string | undefined): void {
  const hasUnread = useUnreadByAgent(slug) > 0;
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => true);
  const cache = useInboxCache();
  const state = useRef({
    inFlight: false,
    lastAt: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pending: undefined as Pending | undefined,
    /** The call that last failed: not repeated until the newest event or the slug changes, or the tab returns. */
    failed: undefined as Pending | undefined,
  });

  const request = useCallback(
    (want: Pending) => {
      const st = state.current;
      if (st.failed?.slug === want.slug && st.failed.upTo === want.upTo) return;
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
        cache.readFrom(next.slug);
        postReadFrom(next.slug, next.upTo)
          .catch(() => {
            st.failed = next;
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
    if (!visible) state.current.failed = undefined;
    if (visible && hasUnread && newestEventAt) request({ slug, upTo: newestEventAt });
  }, [slug, hasUnread, newestEventAt, visible, request]);

  // Another agent's session, or leaving: the trailing call for this one is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: slug is the trigger, not a read
  useEffect(
    () => () => {
      const st = state.current;
      clearTimeout(st.timer);
      st.timer = undefined;
      st.pending = undefined;
    },
    [slug],
  );
}
