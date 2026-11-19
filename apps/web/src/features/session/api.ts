import {
  agentDetailSchema,
  agentListSchema,
  apiFetch,
  eventsPageSchema,
  queueItemResponseSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

type Running = { count: number; max: number };
const fetchList = (archived: "exclude" | "only") =>
  apiFetch(`/api/agents?archived=${archived}`, { schema: agentListSchema });

/** Key prefix ["agents"] covers every list variant, so one invalidation refreshes them all. Each
 *  fetch also refreshes the factory-wide running count (UI design §4). */
export const agentsListQueryOptions = (archived: "exclude" | "only" = "exclude") =>
  queryOptions({
    queryKey: ["agents", archived],
    queryFn: async ({ client }) => {
      const r = await fetchList(archived);
      client.setQueryData<Running>(runningQueryKey, r.running);
      return r.agents;
    },
  });

/** Running agents and the cap, live from the `supervisor` frame (folded in by useAgentStatusFrames). */
export const runningQueryKey = ["supervisor"] as const;
export const runningQueryOptions = queryOptions({
  queryKey: runningQueryKey,
  queryFn: () => fetchList("exclude").then((r): Running => r.running),
  // Frames keep it current; a list fetch also refreshes it.
  staleTime: Number.POSITIVE_INFINITY,
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

const postEmpty = (slug: string, action: "restart" | "reset-session") =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/${action}`, {
    method: "POST",
    body: {},
    schema: z.object({}),
  }).then(() => undefined);
export const postRestart = (slug: string) => postEmpty(slug, "restart");
export const postResetSession = (slug: string) => postEmpty(slug, "reset-session");
