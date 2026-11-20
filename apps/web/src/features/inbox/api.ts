import { apiFetch, type inboxItemSchema, inboxPageSchema } from "@open-factory/shared";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import type { z } from "zod";

export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxQueryKey = ["inbox"] as const;

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
