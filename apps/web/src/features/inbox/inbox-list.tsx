import type { ChatRow } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { requestComposerFocus } from "@/features/session/session-commands";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { onRowKeyDown } from "@/lib/row-nav";
import { runInstantOn } from "@/lib/run-instant";
import { sessionQueryOptions } from "@/lib/session";
import { shouldIgnore } from "@/lib/shortcuts";
import { PREFETCH_REST_MS } from "@/lib/timing";
import {
  chatRowId,
  chatSlugOf,
  type InboxItem,
  prefetchChat,
  prefetchPane,
  useInbox,
  useInboxChats,
  useOpenItem,
} from "./api";
import { ChatInboxRow } from "./chat-row";
import { InboxRow } from "./inbox-row";
import { useHeldList } from "./use-held-list";

const plainClick = (e: MouseEvent) =>
  e.type === "click" && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

/** A row of the list: an unread chat or an item, in one order by time. */
type Row =
  | { kind: "chat"; id: string; at: string; chat: ChatRow }
  | { kind: "item"; id: string; at: string; item: InboxItem };

const rowKey = (r: Row) => r.id;
/** A row the live list dropped, still on screen while held: read, with no count. */
const asRead = (r: Row): Row =>
  r.kind === "chat"
    ? { ...r, chat: { ...r.chat, unread: 0 } }
    : { ...r, item: { ...r.item, read: true } };
const NO_ITEMS: InboxItem[] = [];

/**
 * The chats and the items by time, newest first. While more pages exist, a chat older than the oldest
 * loaded item waits until a page reaches its time (I1 §6.7).
 */
function interleave(chats: readonly ChatRow[], items: readonly InboxItem[], more: boolean): Row[] {
  const oldest = more ? items.at(-1)?.createdAt : undefined;
  const rows: Row[] = [];
  for (const chat of chats)
    if (oldest === undefined || chat.latest.createdAt >= oldest)
      rows.push({ kind: "chat", id: chatRowId(chat.agent.slug), at: chat.latest.createdAt, chat });
  for (const item of items) rows.push({ kind: "item", id: item.id, at: item.createdAt, item });
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The Inbox: a plain list of links, one per unread chat and per item sent to the humans (and factory
 *  items), newest first. Arrow keys also move between rows; Tab reaches every row link as usual.
 *  With `onSelect` (the two-pane layout) a plain click, Enter or Space selects a row (push); an item is
 *  marked read at once, a chat by the pane after INBOX_DWELL_MS. `j`/`k` move the selection (replace).
 *  Enter or `r` on a chat row also moves focus to the pane's composer. While the pointer or focus is in
 *  the list, rows are not removed, re-sorted or inserted (`useHeldList`). */
export function InboxList({
  selectedId,
  selectedChat,
  onSelect,
}: {
  selectedId?: string;
  /** The selected chat when it has nothing unread (a reload, Back): a read row that keeps its place. */
  selectedChat?: ChatRow | undefined;
  onSelect?: (id: string, replace: boolean) => void;
} = {}) {
  const q = useInbox();
  const qc = useQueryClient();
  const open = useOpenItem();
  const viewer = useQuery(sessionQueryOptions).data?.user.handle;
  const items = q.data ?? NO_ITEMS;
  const loaded = q.data !== undefined;
  const chats = useInboxChats();
  const visible = useDocumentVisible();
  const list = useRef<HTMLUListElement>(null);
  // The rows' times are relative to the minute: a number, so a selection doesn't re-render every row.
  const now = Math.floor(Date.now() / 60_000) * 60_000;

  // The selected chat stays a row once it has been read (or never was unread): the last row seen, else
  // the one the route builds, shown read. The ref is written during render because the same render reads
  // it (an effect would show one frame without the row); the write is idempotent.
  const selectedSlug = chatSlugOf(selectedId);
  const lastSelected = useRef<ChatRow>(undefined);
  const inList = selectedSlug ? chats.find((c) => c.agent.slug === selectedSlug) : undefined;
  if (inList) lastSelected.current = inList;
  else if (lastSelected.current?.agent.slug !== selectedSlug) lastSelected.current = undefined;

  // A chat on screen in the pane doesn't bump its count: the one shown is capped at what it was when selected.
  const [cap, setCap] = useState<{ id: string | undefined; n: number }>();
  // It only ratchets down: once the pane has read the chat, a message that arrives while it is shown stays uncounted.
  if (loaded && cap?.id !== selectedId) setCap({ id: selectedId, n: inList?.unread ?? 0 });
  else if (cap && inList && inList.unread < cap.n) setCap({ id: cap.id, n: inList.unread });

  const live = useMemo(() => {
    const shown = chats.map((c) =>
      visible && cap && c.agent.slug === selectedSlug && cap.id === selectedId
        ? { ...c, unread: Math.min(c.unread, cap.n) }
        : c,
    );
    const fallback = lastSelected.current ?? selectedChat;
    if (selectedSlug && !inList && fallback?.agent.slug === selectedSlug)
      shown.push({ ...fallback, unread: 0 });
    return interleave(shown, items, q.hasNextPage);
  }, [chats, items, q.hasNextPage, visible, cap, selectedId, selectedSlug, inList, selectedChat]);
  const held = useHeldList(live, rowKey, asRead, selectedId);
  const rows = held.rows;

  // Read by timers when they fire, so they never act on a stale row (one read since, or gone).
  const latest = useRef(rows);
  useEffect(() => {
    latest.current = rows;
  }, [rows]);
  const byId = (id: string) => latest.current.find((r) => r.id === id);

  // The pane data of the neighbours once the selection has rested, and of a row once the pointer has
  // rested on it (a plain click selects, so the link's own route preload is off).
  const warm = useCallback(
    (id: string | undefined) => {
      const n = id ? latest.current.find((r) => r.id === id) : undefined;
      if (n?.kind === "item") prefetchPane(qc, n.item);
      else if (n) prefetchChat(qc, n.chat.agent.slug);
    },
    [qc],
  );
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const prevId = index > 0 ? rows[index - 1]?.id : undefined;
  const nextId = index >= 0 ? rows[index + 1]?.id : undefined;
  useEffect(() => {
    if (!prevId && !nextId) return;
    const timer = setTimeout(() => {
      warm(prevId);
      warm(nextId);
    }, PREFETCH_REST_MS);
    return () => clearTimeout(timer);
  }, [prevId, nextId, warm]);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const onPointerOver = (e: PointerEvent<HTMLUListElement>) => {
    clearTimeout(hover.current);
    const id = (e.target as Element).closest<HTMLElement>("a[data-inbox-id]")?.dataset.inboxId;
    if (id) hover.current = setTimeout(() => warm(id), PREFETCH_REST_MS);
  };

  const onOpen = useCallback(
    (item: InboxItem, e: MouseEvent) => {
      if (onSelect && plainClick(e)) {
        e.preventDefault();
        onSelect(item.id, false);
      }
      open(item);
    },
    [onSelect, open],
  );

  const onOpenChat = useCallback(
    (slug: string, e: MouseEvent) => {
      if (onSelect && plainClick(e)) {
        e.preventDefault();
        onSelect(chatRowId(slug), false);
      }
    },
    [onSelect],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const row = onRowKeyDown(e);
    if (!onSelect || !list.current) return;
    const el = list.current;
    if (row && (e.key === "j" || e.key === "k")) {
      const id = row.dataset.inboxId;
      if (!id || id === selectedId) return;
      runInstantOn(el, () => onSelect(id, true));
      return;
    }
    if (!(e.target instanceof HTMLAnchorElement) || shouldIgnore(e.nativeEvent)) return;
    const target = byId(e.target.dataset.inboxId ?? "");
    if (!target) return;
    // On a chat, Enter and `r` also move focus to the pane's composer (it never takes it by itself).
    if (target.kind === "chat" && (e.key === "Enter" || e.key === "r")) {
      requestComposerFocus(target.chat.agent.slug);
      if (e.key === "Enter") return; // the link's own click selects it
      e.preventDefault();
      runInstantOn(el, () => onSelect(target.id, false));
      return;
    }
    // Space selects the focused row, as Enter does (the shortcuts sheet's "Select or peek row").
    if (e.key === " ") {
      e.preventDefault();
      runInstantOn(el, () => onSelect(target.id, false));
      if (target.kind === "item") open(target.item);
    }
  };
  // Pending focus, set only once a fetch has settled successfully: the control that was pressed may
  // have unmounted. A row id means "the row after it" (the last row when nothing new arrived);
  // "first" is the first row. Never armed by an error, so a later refetch can't steal focus.
  const [focusAfter, setFocusAfter] = useState<string | "first" | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a") ?? [])];
    const i =
      focusAfter === "first" ? 0 : links.findIndex((l) => l.dataset.inboxId === focusAfter) + 1;
    (links[i] ?? links.at(-1))?.focus();
  }, [focusAfter]);

  if (!loaded)
    return q.isError ? (
      <ErrorLine
        text="Couldn't load the inbox."
        onRetry={() =>
          void q.refetch().then((r) => {
            if (r.isSuccess) setFocusAfter("first");
          })
        }
      />
    ) : null;
  if (rows.length === 0) return <EmptyState text="Nothing in your inbox." />;

  const loadEarlier = () => {
    const last = items.at(-1)?.id;
    void q.fetchNextPage().then((r) => {
      if (r.isSuccess && last !== undefined) setFocusAfter(last);
    });
  };
  return (
    <div className="grid gap-4">
      <ul
        ref={list}
        aria-label="Inbox"
        onKeyDown={onKeyDown}
        onPointerOver={onPointerOver}
        {...held.handlers}
        onPointerLeave={() => {
          clearTimeout(hover.current);
          held.handlers.onPointerLeave();
        }}
        className="border-y border-border [overflow-anchor:auto]"
      >
        {rows.map((r) =>
          r.kind === "chat" ? (
            <ChatInboxRow
              key={r.id}
              row={r.chat}
              now={now}
              onOpen={onOpenChat}
              selected={r.id === selectedId}
              selectable={onSelect !== undefined}
            />
          ) : (
            <InboxRow
              key={r.id}
              item={r.item}
              now={now}
              onOpen={onOpen}
              selected={r.id === selectedId}
              selectable={onSelect !== undefined}
              viewer={viewer}
            />
          ),
        )}
      </ul>
      {q.isFetchNextPageError ? (
        <ErrorLine text="Couldn't load earlier messages." onRetry={loadEarlier} autoFocus />
      ) : (
        q.hasNextPage && (
          <div>
            <Button variant="outline" onClick={loadEarlier} disabled={q.isFetchingNextPage}>
              Load earlier
            </Button>
          </div>
        )
      )}
    </div>
  );
}
