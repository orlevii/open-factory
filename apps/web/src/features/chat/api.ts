import { apiFetch, chatPageSchema } from "@open-factory/shared";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

type ChatQuery = { before?: string; around?: string; limit?: number };

export function fetchChat(slug: string, q: ChatQuery = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return apiFetch(`/api/agents/${encodeURIComponent(slug)}/chat?${p}`, { schema: chatPageSchema });
}

/** The newest page, then older ones by `nextCursor`. */
export const chatQueryOptions = (slug: string) =>
  infiniteQueryOptions({
    queryKey: ["chat", slug],
    queryFn: ({ pageParam }) => fetchChat(slug, pageParam ? { before: pageParam } : {}),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  });

/** The window around one message (`?message=`). */
export const chatAroundQueryOptions = (slug: string, messageId: string) =>
  queryOptions({
    queryKey: ["chat", slug, "around", messageId],
    queryFn: () => fetchChat(slug, { around: messageId }),
    staleTime: 0,
  });
