import {
  type AgentSummary,
  agentDetailSchema,
  agentListSchema,
  agentResponseSchema,
  apiFetch,
  eventsPageSchema,
  messageLookupSchema,
  queueItemResponseSchema,
} from "@open-factory/shared";
import { type QueryClient, queryOptions, skipToken } from "@tanstack/react-query";
import { z } from "zod";

type Running = { count: number; max: number };
const fetchList = (ended: "exclude" | "only") =>
  apiFetch(`/api/agents?ended=${ended}`, { schema: agentListSchema });

/** Key prefix ["agents"] covers every list variant, so one invalidation refreshes them all. Each
 *  fetch also refreshes the factory-wide running count (UI design §4), and the ended list whether
 *  older ended agents exist beyond the newest 200 it holds (S7 UI design §3). */
export const agentsListQueryOptions = (ended: "exclude" | "only" = "exclude") =>
  queryOptions({
    queryKey: ["agents", ended],
    queryFn: async ({ client }) => {
      const r = await fetchList(ended);
      client.setQueryData<Running>(runningQueryKey, r.running);
      if (ended === "only") client.setQueryData<boolean>(endedMoreQueryKey, r.more);
      return r.agents;
    },
  });

/** Outside the ["agents"] prefix: every value under it is an agent array (useAgentStatusFrames). */
export const endedMoreQueryKey = ["ended-more"] as const;
/** Filled by the ended list's fetch only (`skipToken`: it never fetches on its own). */
export const endedMoreQueryOptions = queryOptions<boolean>({
  queryKey: endedMoreQueryKey,
  queryFn: skipToken,
  staleTime: Number.POSITIVE_INFINITY,
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

/** The agent's row from any cached list (active or ended), so a page can render its name and status
 *  while the detail loads (spec §11). A plain cache read: it does not subscribe. */
export function summaryFromAgentsList(qc: QueryClient, slug: string): AgentSummary | undefined {
  for (const [, list] of qc.getQueriesData<AgentSummary[]>({ queryKey: ["agents"] })) {
    const hit = list?.find((a) => a.slug === slug);
    if (hit) return hit;
  }
  return undefined;
}

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

export const fetchMessage = (id: string) =>
  apiFetch(`/api/messages/${encodeURIComponent(id)}`, { schema: messageLookupSchema });

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

/** S7: terminate a spawned agent (idempotent: one already terminated comes back as it is). */
export const postTerminate = (slug: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/terminate`, {
    method: "POST",
    body: {},
    schema: agentResponseSchema,
  }).then((r) => r.agent);

/** S7: pin (PUT) or unpin (DELETE) a terminated agent's workspace. */
export const setWorkspacePin = (slug: string, pinned: boolean) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/workspace-pin`, {
    method: pinned ? "PUT" : "DELETE",
    schema: agentResponseSchema,
  }).then((r) => r.agent);
