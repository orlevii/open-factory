import {
  apiFetch,
  type inboxItemSchema,
  inboxPageSchema,
  readAllResponseSchema,
  undoReadAllResponseSchema,
  unreadCountSchema,
} from "@open-factory/shared";
import {
  type InfiniteData,
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

export type InboxItem = z.infer<typeof inboxItemSchema>;
type Page = z.infer<typeof inboxPageSchema>;

export const inboxQueryKey = ["inbox"] as const;
export const unreadQueryKey = ["inbox-unread"] as const;
export const homeInboxQueryKey = ["inbox-home"] as const;

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

/** Home's panel: the 5 newest unread items. */
export const homeInboxQueryOptions = queryOptions({
  queryKey: homeInboxQueryKey,
  queryFn: () => apiFetch("/api/inbox?unread=true&limit=5", { schema: inboxPageSchema }),
  select: (p: Page) => p.items,
});

export const unreadCountQueryOptions = queryOptions({
  queryKey: unreadQueryKey,
  queryFn: () => apiFetch("/api/inbox/unread-count", { schema: unreadCountSchema }),
  select: (d: { count: number }) => d.count,
});
/** The sidebar's count: refetched on `inbox_changed`, decremented optimistically when a row is opened. */
export const useUnreadCount = () => useQuery(unreadCountQueryOptions);

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
export const postUndoReadAll = (readAt: string) =>
  apiFetch("/api/inbox/read-all/undo", {
    method: "POST",
    body: { readAt },
    schema: undoReadAllResponseSchema,
  });

/** Flips `read` for the given ids in every cached inbox view, and moves the unread count by `delta`. */
export function useInboxCache() {
  const qc = useQueryClient();
  return {
    setRead(ids: Set<string>, read: boolean, delta: number) {
      const flip = (items: InboxItem[]) => items.map((i) => (ids.has(i.id) ? { ...i, read } : i));
      qc.setQueryData<InfiniteData<Page>>(
        inboxQueryKey,
        (d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, items: flip(p.items) })) },
      );
      qc.setQueryData<Page>(homeInboxQueryKey, (p) => p && { ...p, items: flip(p.items) });
      qc.setQueryData<{ count: number }>(
        unreadQueryKey,
        (c) => c && { count: Math.max(0, c.count + delta) },
      );
    },
    refetch() {
      for (const key of [inboxQueryKey, unreadQueryKey, homeInboxQueryKey])
        void qc.invalidateQueries({ queryKey: key });
    },
  };
}

/**
 * Opening a row (click, Cmd/Ctrl-click, middle-click, Enter): the row turns read and the count drops at once, the
 * request is fired without being awaited, and a failure puts both back (UI design §3).
 */
export function useOpenItem() {
  const cache = useInboxCache();
  return (item: InboxItem) => {
    if (item.read) return;
    const ids = new Set([item.id]);
    cache.setRead(ids, true, -1);
    postRead(item.id).catch(() => cache.setRead(ids, false, +1));
  };
}
