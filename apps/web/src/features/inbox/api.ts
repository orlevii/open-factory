import {
  apiFetch,
  inboxItemResponseSchema,
  type inboxItemSchema,
  inboxPageSchema,
  readAllResponseSchema,
  readFromResponseSchema,
  undoReadAllResponseSchema,
  unreadCountSchema,
} from "@open-factory/shared";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { fetchEvents } from "@/features/session/api";
import { taskDetailOptions } from "@/features/tasks/api";

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

/** One item, for a `?item=` outside the loaded pages (the list's pages don't change). */
export const inboxItemOptions = (id: string) =>
  queryOptions({
    queryKey: [...inboxQueryKey, "item", id] as const,
    queryFn: () =>
      apiFetch(`/api/inbox/${encodeURIComponent(id)}`, { schema: inboxItemResponseSchema }).then(
        (r) => r.item,
      ),
  });

/** The reading pane's excerpt of a session: 7 events around `seq`, or the latest 7 without one. */
export const EXCERPT_LIMIT = 7;
export const excerptOptions = (slug: string, seq: number | undefined) =>
  queryOptions({
    queryKey: ["agent", slug, "excerpt", seq ?? "latest"] as const,
    // The signal: a j/k sweep's passed-over rows are cancelled once the pane moves on.
    queryFn: ({ signal }) =>
      fetchEvents(
        slug,
        seq === undefined ? { limit: EXCERPT_LIMIT } : { around: seq, limit: EXCERPT_LIMIT },
        signal,
      ),
  });

/** Warms what the reading pane shows for `item`: the session excerpt at its target, or its task. */
export function prefetchPane(qc: QueryClient, item: InboxItem) {
  const link = item.link;
  void (link.kind === "session"
    ? qc.prefetchQuery(excerptOptions(link.agentSlug, link.seq))
    : qc.prefetchQuery(taskDetailOptions(link.key)));
}

/** The 5 newest unread items: what the notifier reads. */
export const homeInboxQueryOptions = queryOptions({
  queryKey: homeInboxQueryKey,
  queryFn: () => apiFetch("/api/inbox?unread=true&limit=5", { schema: inboxPageSchema }),
  select: (p: Page) => p.items,
});

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
export const postReadFrom = (slug: string, upTo: string) =>
  apiFetch(`/api/inbox/read-from/${encodeURIComponent(slug)}`, {
    method: "POST",
    body: { upTo },
    schema: readFromResponseSchema,
  });
export const postUndoReadAll = (readAt: string) =>
  apiFetch("/api/inbox/read-all/undo", {
    method: "POST",
    body: { readAt },
    schema: undoReadAllResponseSchema,
  });

const fromAgent = (i: InboxItem) =>
  i.kind === "message" && i.from.kind === "agent" ? i.from.name : null;

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
      qc.setQueryData<Page>(homeInboxQueryKey, (p) => p && { ...p, items: flip(p.items) });
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
      /** "Mark read" for one agent: its cached rows turn read and its count goes to zero. */
      readFrom(slug: string) {
        flipRows((i) => fromAgent(i) === slug, true);
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
      refetch() {
        for (const key of [inboxQueryKey, unreadQueryKey, homeInboxQueryKey])
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
