import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import {
  inboxQueryOptions,
  postReadAll,
  postUndoReadAll,
  unreadCountQueryOptions,
  useInboxCache,
} from "./api";

type Outcome =
  | { tone: "success"; count: number; readAt: string; key: number }
  | { tone: "error"; kind: "mark" | "undo"; key: number }
  | undefined;

/**
 * Mark all read with an exact Undo (UI design §3). The loaded rows turn read at once; the request carries `upTo` (the
 * newest loaded item), so items arriving meanwhile stay unread. `outcome` feeds `InlineOutcome` in the page body.
 */
export function useMarkAllRead(buttonRef: RefObject<HTMLButtonElement | null>) {
  const cache = useInboxCache();
  const { data: items } = useInfiniteQuery(inboxQueryOptions);
  const { data: unread = 0 } = useQuery(unreadCountQueryOptions);
  const [outcome, setOutcome] = useState<Outcome>();
  const [pending, setPending] = useState(false);
  const key = useRef(0);
  const focusButton = useRef(false);
  // After Undo, focus returns to "Mark all read" once it is back (it hides at 0 unread).
  useEffect(() => {
    if (focusButton.current && buttonRef.current) {
      focusButton.current = false;
      buttonRef.current.focus();
    }
  });

  async function run() {
    const loaded = items ?? [];
    const newest = loaded[0];
    if (!newest || pending) return;
    const ids = new Set(loaded.filter((i) => !i.read).map((i) => i.id));
    cache.setRead(ids, true, -ids.size);
    setOutcome(undefined);
    setPending(true);
    try {
      const r = await postReadAll(newest.createdAt);
      setOutcome({ tone: "success", count: r.count, readAt: r.readAt, key: ++key.current });
      cache.refetch();
    } catch {
      cache.setRead(ids, false, +ids.size);
      setOutcome({ tone: "error", kind: "mark", key: ++key.current });
    } finally {
      setPending(false);
    }
  }
  async function undo(readAt: string) {
    setPending(true);
    try {
      await postUndoReadAll(readAt);
      setOutcome(undefined);
      focusButton.current = true;
      cache.refetch();
    } catch {
      setOutcome({ tone: "error", kind: "undo", key: ++key.current });
    } finally {
      setPending(false);
    }
  }
  return {
    unread,
    pending,
    outcome,
    run: () => void run(),
    undo: (readAt: string) => void undo(readAt),
  };
}

export function MarkAllReadButton({
  state,
  buttonRef,
}: {
  state: ReturnType<typeof useMarkAllRead>;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  if (state.unread <= 0) return null;
  return (
    <Button ref={buttonRef} variant="ghost" onClick={state.run} disabled={state.pending}>
      Mark all read
    </Button>
  );
}

/** The outcome line at the top of the page body (S4's `InlineOutcome`, as the archive undo does). */
export function MarkAllReadOutcome({
  state,
  lastReadAt,
}: {
  state: ReturnType<typeof useMarkAllRead>;
  lastReadAt: RefObject<string | undefined>;
}) {
  const o = state.outcome;
  if (o?.tone === "success") lastReadAt.current = o.readAt;
  return (
    <InlineOutcome
      tone={o?.tone}
      focusKey={o?.key}
      {...(o?.tone === "success" ? { undo: () => state.undo(o.readAt) } : {})}
    >
      {o?.tone === "success" ? (
        `Marked ${o.count} ${o.count === 1 ? "item" : "items"} as read.`
      ) : o?.tone === "error" ? (
        <>
          {o.kind === "mark" ? "Couldn't mark the items as read." : "Couldn't undo. Try again."}{" "}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              o.kind === "mark" ? state.run() : lastReadAt.current && state.undo(lastReadAt.current)
            }
          >
            Retry
          </Button>
        </>
      ) : null}
    </InlineOutcome>
  );
}
