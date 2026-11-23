import { apiFetch, chatPageSchema } from "@open-factory/shared";
import { infiniteQueryOptions } from "@tanstack/react-query";

type ChatQuery = { before?: string; around?: string; limit?: number };

export function fetchChat(slug: string, q: ChatQuery = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return apiFetch(`/api/agents/${encodeURIComponent(slug)}/chat?${p}`, { schema: chatPageSchema });
}

/** The infinite chat queries are written by `use-chat` (the union), never refetched wholesale: no
 *  window-focus, reconnect or mount refetch, nothing is stale, and structural sharing is the union's
 *  job (I1 §6.5). */
const OWN_REFRESH = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
  structuralSharing: false,
} as const;

const olderThan = (cursor: string) => ({ before: cursor });

/** The newest page, then older ones by `nextCursor`. */
export const chatQueryOptions = (slug: string) =>
  infiniteQueryOptions({
    queryKey: ["chat", slug],
    queryFn: ({ pageParam }) => fetchChat(slug, pageParam ? olderThan(pageParam) : {}),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...OWN_REFRESH,
  });

/** The window around one message (`?message=`), then older pages like the newest query. */
export const chatAroundQueryOptions = (slug: string, messageId: string) =>
  infiniteQueryOptions({
    queryKey: ["chat", slug, "around", messageId],
    queryFn: ({ pageParam }) =>
      fetchChat(slug, pageParam ? olderThan(pageParam) : { around: messageId }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...OWN_REFRESH,
  });
