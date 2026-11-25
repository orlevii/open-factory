import {
  ApiError,
  apiFetch,
  type ChatRow,
  inboxItemResponseSchema,
  type inboxItemSchema,
  inboxPageSchema,
  readAllResponseSchema,
  readFromResponseSchema,
  resumeLoopHoldResponseSchema,
  undoReadAllResponseSchema,
  unreadCountSchema,
} from "@open-factory/shared";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { chatQueryOptions } from "@/features/chat/api";
import { taskDetailOptions } from "@/features/tasks/api";

export type InboxItem = z.infer<typeof inboxItemSchema>;
type Page = z.infer<typeof inboxPageSchema>;

export const inboxQueryKey = ["inbox"] as const;
export const unreadQueryKey = ["inbox-unread"] as const;

/** Pages are merged by `id` (first occurrence wins), so a refetch that overlaps an older page, or a
 *  row that moved between pages, never shows twice. */
const flatten = (data: { pages: { items: InboxItem[] }[] }): InboxItem[] => {
  const seen = new Set<string>();
  return data.pages.flatMap((p) => p.items).filter((i) => !seen.has(i.id) && seen.add(i.id));
};

export const inboxQueryOptions = infiniteQueryOptions({
  queryKey: inboxQueryKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    apiFetch(`/api/inbox?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`, {
      schema: inboxPageSchema,
    }),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  select: flatten,
});

/** The Inbox as one infinite query keyed `["inbox"]`; `inbox_changed` invalidates it. */
export const useInbox = () => useInfiniteQuery(inboxQueryOptions);

/** A chat row's id in the list, the selection and `?item=`: the item ids are uuids, so they never collide. */
export const CHAT_ID_PREFIX = "chat:";
export const chatRowId = (slug: string) => `${CHAT_ID_PREFIX}${slug}`;
/** The agent slug of a `chat:<slug>` id, else undefined. */
export const chatSlugOf = (id: string | undefined): string | undefined =>
  id?.startsWith(CHAT_ID_PREFIX) && id.length > CHAT_ID_PREFIX.length
    ? id.slice(CHAT_ID_PREFIX.length)
    : undefined;

const NO_CHATS: ChatRow[] = [];
/** The unread chats (only the first page carries them); structurally shared, so a refetch that changes
 *  nothing renders nothing. */
const chatsOf = (d: { pages: { chats?: ChatRow[] | undefined }[] }): ChatRow[] =>
  d.pages[0]?.chats ?? NO_CHATS;
export const useInboxChats = () =>
  useInfiniteQuery({ ...inboxQueryOptions, select: chatsOf }).data ?? NO_CHATS;

/** The unread member updates of your reports, one row per report (the first page carries them): a row's shape
 *  is a chat row's. They are never fed to the notifier. */
const updatesOf = (d: { pages: { updates?: ChatRow[] | undefined }[] }): ChatRow[] =>
  d.pages[0]?.updates ?? NO_CHATS;
export const useInboxUpdates = () =>
  useInfiniteQuery({ ...inboxQueryOptions, select: updatesOf }).data ?? NO_CHATS;
/** An update row's id in the list's rows (never a selection: it opens the report's session). */
export const updateRowId = (slug: string) => `update:${slug}`;

/** One item, for a `?item=` outside the loaded pages (the list's pages don't change). */
export const inboxItemOptions = (id: string) =>
  queryOptions({
    queryKey: [...inboxQueryKey, "item", id] as const,
    queryFn: () =>
      apiFetch(`/api/inbox/${encodeURIComponent(id)}`, { schema: inboxItemResponseSchema }).then(
        (r) => r.item,
      ),
  });

/** Warms what the reading pane shows for `item`: its task (a notice or a credential has nothing to fetch). */
export function prefetchPane(qc: QueryClient, item: InboxItem) {
  const link = item.link;
  switch (link.kind) {
    case "task":
      void qc.prefetchQuery(taskDetailOptions(link.key));
      return;
    case "session":
    case "credential":
      return;
    default: {
      const unhandled: never = link;
      return unhandled;
    }
  }
}

/** Warms a chat row's pane: the chat's newest page. */
export function prefetchChat(qc: QueryClient, slug: string) {
  if (qc.getQueryData(chatQueryOptions(slug).queryKey) === undefined)
    void qc.prefetchInfiniteQuery(chatQueryOptions(slug));
}

export type Unread = { count: number; byAgent: Record<string, number> };

export const unreadCountQueryOptions = queryOptions({
  queryKey: unreadQueryKey,
  queryFn: () => apiFetch("/api/inbox/unread-count", { schema: unreadCountSchema }),
  select: (d: Unread) => d.count,
});
/** The sidebar's count: refetched on `inbox_changed`, decremented optimistically when a row is opened. */
export const useUnreadCount = () => useQuery(unreadCountQueryOptions);

/** One agent's unread messages to the viewer; shares the cached count query, never mounts a fetch of its own. */
export const useUnreadByAgent = (slug: string): number =>
  useQuery({
    ...unreadCountQueryOptions,
    select: useCallback((d: Unread) => d.byAgent[slug] ?? 0, [slug]),
    refetchOnMount: false,
  }).data ?? 0;

const okSchema = z.object({ ok: z.literal(true) });
export const postRead = (id: string) =>
  apiFetch(`/api/inbox/${encodeURIComponent(id)}/read`, {
    method: "POST",
    body: {},
    schema: okSchema,
  });
export const postReadAll = (upTo: string) =>
  apiFetch("/api/inbox/read-all", {
    method: "POST",
    body: { upTo },
    schema: readAllResponseSchema,
  });
export const postReadFrom = (slug: string, upTo: string, kind?: "member_update") =>
  apiFetch(`/api/inbox/read-from/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: kind ? { upTo, kind } : { upTo },
    schema: readFromResponseSchema,
  });
export const postUndoReadAll = (readAt: string) =>
  apiFetch("/api/inbox/read-all/undo", {
    method: "POST",
    body: { readAt },
    schema: undoReadAllResponseSchema,
  });

const fromAgent = (i: InboxItem) =>
  i.kind === "notice" && i.from.kind === "agent" ? i.from.name : null;

/** Flips `read` for the given ids in every cached inbox view, and moves the unread count by `delta`. With `items`,
 *  each agent-sender's count moves too; without them `byAgent` is left for the refetch. */
export function useInboxCache() {
  const qc = useQueryClient();
  return useMemo(() => {
    const flipRows = (match: (i: InboxItem) => boolean, read: boolean) => {
      const flip = (items: InboxItem[]) => items.map((i) => (match(i) ? { ...i, read } : i));
      qc.setQueryData<InfiniteData<Page>>(
        inboxQueryKey,
        (d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, items: flip(p.items) })) },
      );
    };
    return {
      setRead(ids: Set<string>, read: boolean, delta: number, items?: InboxItem[]) {
        flipRows((i) => ids.has(i.id), read);
        // The reading pane's own copy of an item outside the loaded pages, when there is one: it
        // turns (and, on a failed read, turns back) with the rows.
        for (const id of ids)
          qc.setQueryData(inboxItemOptions(id).queryKey, (i) => i && { ...i, read });
        const byAgent: Record<string, number> = {};
        for (const i of items ?? []) {
          const from = fromAgent(i);
          if (from) byAgent[from] = (byAgent[from] ?? 0) + (read ? -1 : 1);
        }
        qc.setQueryData<Unread>(unreadQueryKey, (c) => {
          if (!c) return c;
          const next = { ...c.byAgent };
          for (const [k, d] of Object.entries(byAgent)) next[k] = Math.max(0, (next[k] ?? 0) + d);
          return { ...c, count: Math.max(0, c.count + delta), byAgent: next };
        });
      },
      /** Mark all read, for the chats it covers: each chat's row goes to no count (or back to `counts`), its
       *  `byAgent` entry with it, and the total moves by their sum. */
      setChatsRead(counts: ReadonlyMap<string, number>, read: boolean) {
        let sum = 0;
        for (const n of counts.values()) sum += n;
        qc.setQueryData<InfiniteData<Page>>(
          inboxQueryKey,
          (d) =>
            d && {
              ...d,
              pages: d.pages.map((p) => ({
                ...p,
                ...(p.chats && {
                  chats: p.chats.map((c) =>
                    counts.has(c.agent.slug)
                      ? {
                          ...c,
                          unread: read ? 0 : Math.max(c.unread, counts.get(c.agent.slug) ?? 0),
                        }
                      : c,
                  ),
                }),
              })),
            },
        );
        qc.setQueryData<Unread>(unreadQueryKey, (c) => {
          if (!c) return c;
          const byAgent = { ...c.byAgent };
          for (const [slug, n] of counts)
            byAgent[slug] = read ? 0 : Math.max(0, (byAgent[slug] ?? 0) + n);
          return { ...c, count: Math.max(0, c.count + (read ? -sum : sum)), byAgent };
        });
      },
      /** "Mark read" for one agent: its cached rows turn read and its count goes to zero. */
      readFrom(slug: string) {
        flipRows((i) => fromAgent(i) === slug, true);
        // The chat's row stays in the cache with no count; the list drops it when it can (a held list waits).
        qc.setQueryData<InfiniteData<Page>>(
          inboxQueryKey,
          (d) =>
            d && {
              ...d,
              pages: d.pages.map((p) =>
                p.chats?.some((c) => c.agent.slug === slug)
                  ? {
                      ...p,
                      chats: p.chats.map((c) => (c.agent.slug === slug ? { ...c, unread: 0 } : c)),
                    }
                  : p,
              ),
            },
        );
        qc.setQueryData<Unread>(
          unreadQueryKey,
          (c) =>
            c && {
              ...c,
              count: Math.max(0, c.count - (c.byAgent[slug] ?? 0)),
              byAgent: { ...c.byAgent, [slug]: 0 },
            },
        );
      },
      /** Opening an update row: the report's row leaves the list and the count drops by its updates. */
      readUpdates(slug: string, n: number) {
        qc.setQueryData<InfiniteData<Page>>(
          inboxQueryKey,
          (d) =>
            d && {
              ...d,
              pages: d.pages.map((p) =>
                p.updates ? { ...p, updates: p.updates.filter((u) => u.agent.slug !== slug) } : p,
              ),
            },
        );
        qc.setQueryData<Unread>(
          unreadQueryKey,
          (c) => c && { ...c, count: Math.max(0, c.count - n) },
        );
      },
      refetch() {
        for (const key of [inboxQueryKey, unreadQueryKey])
          void qc.invalidateQueries({ queryKey: key });
      },
    };
  }, [qc]);
}

/**
 * Opening a row (click, Cmd/Ctrl-click, middle-click, Enter): the row turns read and the count drops at once, the
 * request is fired without being awaited, and a failure puts both back (UI design §3).
 */
export function useOpenItem() {
  const cache = useInboxCache();
  return useCallback(
    (item: InboxItem) => {
      if (item.read) return;
      const ids = new Set([item.id]);
      cache.setRead(ids, true, -1, [item]);
      postRead(item.id).catch(() => cache.setRead(ids, false, +1, [item]));
    },
    [cache],
  );
}

/** Opening an update row reads the report's member updates up to its latest; a failure refetches. */
export function useOpenUpdate() {
  const cache = useInboxCache();
  return useCallback(
    (row: ChatRow) => {
      cache.readUpdates(row.agent.slug, row.unread);
      postReadFrom(row.agent.slug, row.latest.createdAt, "member_update").catch(() =>
        cache.refetch(),
      );
    },
    [cache],
  );
}

/** Resume a loop-guard hold (I8 §6.6): the 200's `sentOn` with the moment it answered (the pane shows
 *  "Resumed by you · {at}" before the refetch brings `resumedAt`). The inbox and the item's own query refetch
 *  after any outcome: a 409 means someone else resumed first, and its refetch brings who. */
export function useResumeHold(holdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await apiFetch(`/api/loop-holds/${encodeURIComponent(holdId)}/resume`, {
        method: "POST",
        body: {},
        schema: resumeLoopHoldResponseSchema,
      });
      return { sentOn: r.sentOn, at: new Date().toISOString() };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: inboxQueryKey }),
  });
}

/** Notices whose action lives only in the Inbox: their row links to `/inbox?item=<id>` at every width, and below
 *  1024px the pane opens full-width. */
export const FULL_WIDTH_NOTICES: readonly string[] = ["loop_held"];
export const isFullWidthNotice = (item: InboxItem): boolean =>
  item.notice !== undefined && FULL_WIDTH_NOTICES.includes(item.notice);

/** The selected row from the loaded pages; re-renders only when that row changes. */
export function useLoadedItem(id: string | undefined): InboxItem | undefined {
  return useInfiniteQuery({
    ...inboxQueryOptions,
    select: useCallback(
      (d: { pages: { items: InboxItem[] }[] }) =>
        id === undefined ? undefined : d.pages.flatMap((p) => p.items).find((i) => i.id === id),
      [id],
    ),
  }).data;
}

/**
 * The item to show: the row from the loaded pages; else `GET /api/inbox/:id` (a deep link outside
 * them, or a row a refetch dropped). A row that drops out keeps showing while that fetch runs, so
 * the header never blanks; a 404 is `gone`.
 */
export function usePaneItem(id: string, loaded: InboxItem | undefined) {
  const [kept, setKept] = useState(loaded);
  if (loaded && loaded !== kept) setKept(loaded);
  const fetched = useQuery({ ...inboxItemOptions(id), enabled: !loaded });
  const gone = !loaded && fetched.error instanceof ApiError && fetched.error.status === 404;
  // `kept` is always this id's row: PaneItem is keyed by id.
  const item = loaded ?? (gone ? undefined : (fetched.data ?? kept));
  return { item, gone, failed: !item && !gone && fetched.isError };
}
