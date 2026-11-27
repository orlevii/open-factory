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
  useInboxChats,
} from "./api";

/** What a Mark all read covered: the chats (by unread count) and the loaded items it turned read. */
type Covered = { counts: ReadonlyMap<string, number>; ids: Set<string> };

type Outcome =
  | { tone: "success"; chats: number; items: number; readAt: string; covered: Covered; key: number }
  | { tone: "error"; kind: "mark" | "undo"; key: number }
  | undefined;

/**
 * Mark all read with an exact Undo (UI design §3, I1 §6.7). The loaded rows and the unread chats turn read at once;
 * the request carries `upTo` (the newest of the loaded items and the chats' newest messages), so messages arriving
 * meanwhile stay unread. `outcome` feeds `InlineOutcome` in the page body.
 */
export function useMarkAllRead(buttonRef: RefObject<HTMLButtonElement | null>) {
  const cache = useInboxCache();
  const { data: items } = useInfiniteQuery(inboxQueryOptions);
  const { data: unread = 0 } = useQuery(unreadCountQueryOptions);
  const chats = useInboxChats();
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
    const unreadChats = chats.filter((c) => c.unread > 0);
    const newest = [loaded[0]?.createdAt, ...unreadChats.map((c) => c.latest.createdAt)]
      .filter((t): t is string => t !== undefined)
      .reduce<string | undefined>((a, t) => (a === undefined || t > a ? t : a), undefined);
    if (newest === undefined || pending) return;
    const ids = new Set(loaded.filter((i) => !i.read).map((i) => i.id));
    const counts = new Map(unreadChats.map((c) => [c.agent.ref, c.unread]));
    const messages = unreadChats.reduce((n, c) => n + c.unread, 0);
    cache.setRead(ids, true, -ids.size);
    cache.setChatsRead(counts, true);
    setOutcome(undefined);
    setPending(true);
    try {
      const r = await postReadAll(newest);
      setOutcome({
        tone: "success",
        chats: counts.size,
        // The server counts every row, a chat's messages too; the rest are items.
        items: Math.max(0, r.count - messages),
        readAt: r.readAt,
        covered: { counts, ids },
        key: ++key.current,
      });
      cache.refetch();
    } catch {
      cache.setRead(ids, false, +ids.size);
      cache.setChatsRead(counts, false);
      setOutcome({ tone: "error", kind: "mark", key: ++key.current });
    } finally {
      setPending(false);
    }
  }
  async function undo(readAt: string, covered?: Covered) {
    setPending(true);
    try {
      await postUndoReadAll(readAt);
      // The rows come back at once; the refetch is the truth.
      if (covered) {
        cache.setRead(covered.ids, false, +covered.ids.size);
        cache.setChatsRead(covered.counts, false);
      }
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
    undo: (readAt: string, covered?: Covered) => void undo(readAt, covered),
  };
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "3 chats and 2 items", "1 chat", "1 item": only what there was. */
function markedSentence(chats: number, items: number): string {
  const parts = [
    chats > 0 && plural(chats, "chat"),
    (items > 0 || chats === 0) && plural(items, "item"),
  ];
  return parts.filter(Boolean).join(" and ");
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
      inRows
      tone={o?.tone}
      focusKey={o?.key}
      {...(o?.tone === "success" ? { undo: () => state.undo(o.readAt, o.covered) } : {})}
    >
      {o?.tone === "success" ? (
        `Marked ${markedSentence(o.chats, o.items)} as read.`
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
