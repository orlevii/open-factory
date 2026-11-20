import {
  agentDetailSchema,
  agentListSchema,
  apiFetch,
  eventsPageSchema,
  queueItemResponseSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

/** Key prefix ["agents"] covers every list variant, so one invalidation refreshes them all. */
export const agentsListQueryOptions = (archived: "exclude" | "only" = "exclude") =>
  queryOptions({
    queryKey: ["agents", archived],
    queryFn: () =>
      apiFetch(`/api/agents?archived=${archived}`, { schema: agentListSchema }).then(
        (r) => r.agents,
      ),
  });
export const agentsQueryOptions = agentsListQueryOptions("exclude");

export const agentDetailQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ["agent", slug],
    queryFn: () =>
      apiFetch(`/api/agents/${encodeURIComponent(slug)}`, { schema: agentDetailSchema }),
    staleTime: 0,
  });

export function fetchEvents(
  slug: string,
  q: { before?: number; around?: number; limit?: number } = {},
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return apiFetch(`/api/agents/${encodeURIComponent(slug)}/events?${p}`, {
    schema: eventsPageSchema,
  });
}

export const postMessage = (slug: string, body: string, urgent: boolean) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    body: { body, urgent },
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

export const postCompact = (slug: string, focus?: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/compact`, {
    method: "POST",
    body: focus ? { focus } : {},
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

export const postInterrupt = (slug: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/interrupt`, {
    method: "POST",
    body: {},
    schema: z.object({}),
  }).then(() => undefined);
