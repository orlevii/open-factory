import {
  type AgentSummary,
  agentDetailSchema,
  agentListSchema,
  agentResponseSchema,
  apiFetch,
  eventsPageSchema,
  messageLookupSchema,
  queueItemResponseSchema,
  restartAgentResponseSchema,
} from "@open-factory/shared";
import { type QueryClient, queryOptions, skipToken } from "@tanstack/react-query";
import { z } from "zod";

type Running = { count: number };
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

/** Outside the ["agents"] prefix: every value under it is an agent array (status-frames.ts). */
export const endedMoreQueryKey = ["ended-more"] as const;
/** Filled by the ended list's fetch only (`skipToken`: it never fetches on its own). */
export const endedMoreQueryOptions = queryOptions<boolean>({
  queryKey: endedMoreQueryKey,
  queryFn: skipToken,
  staleTime: Number.POSITIVE_INFINITY,
});

/** Running agents, live from the `supervisor` frame (folded in by status-frames.ts). */
export const runningQueryKey = ["supervisor"] as const;
export const runningQueryOptions = queryOptions({
  queryKey: runningQueryKey,
  queryFn: () => fetchList("exclude").then((r): Running => r.running),
  // Frames keep it current; a list fetch also refreshes it.
  staleTime: Number.POSITIVE_INFINITY,
});
export const agentsQueryOptions = agentsListQueryOptions("exclude");

export const agentDetailQueryOptions = (ref: string) =>
  queryOptions({
    queryKey: ["agent", ref],
    queryFn: () =>
      apiFetch(`/api/agents/${encodeURIComponent(ref)}`, { schema: agentDetailSchema }),
    staleTime: 0,
  });

/** The agent's row from any cached list (active or ended), so a page can render its name and status
 *  while the detail loads (spec §11). A plain cache read: it does not subscribe. */
export function summaryFromAgentsList(qc: QueryClient, ref: string): AgentSummary | undefined {
  for (const [, list] of qc.getQueriesData<AgentSummary[]>({ queryKey: ["agents"] })) {
    // Guarded: a non-list value under the prefix must not throw during render or a socket frame.
    const hit = Array.isArray(list) ? list.find((a) => a.ref === ref) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

export function fetchEvents(
  ref: string,
  q: { before?: number; around?: number; limit?: number } = {},
  signal?: AbortSignal,
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return apiFetch(`/api/agents/${encodeURIComponent(ref)}/events?${p}`, {
    schema: eventsPageSchema,
    signal,
  });
}

export const fetchMessage = (id: string) =>
  apiFetch(`/api/messages/${encodeURIComponent(id)}`, { schema: messageLookupSchema });

/** `POST /api/agents/:ref/input`: the raw text a human types into the session, exactly as typed (I1 §5.1).
 *  `clientMessageId` makes a retry idempotent. */
export const postInput = (
  ref: string,
  body: { text: string; clientMessageId: string },
  signal?: AbortSignal,
) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/input`, {
    method: "POST",
    body,
    schema: queueItemResponseSchema,
    ...(signal ? { signal } : {}),
  }).then((r) => r.item);

/** U3 §6.4: withdraw a held message you sent; resolves to the cancelled item. */
export const cancelQueued = (ref: string, messageId: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/queue/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

/** U3 §6.4: Undo of a cancel (204); the restored item arrives in the next `queue` frame. */
export const restoreQueued = (ref: string, messageId: string) =>
  apiFetch(
    `/api/agents/${encodeURIComponent(ref)}/queue/${encodeURIComponent(messageId)}/restore`,
    { method: "POST", body: {}, schema: z.unknown() },
  ).then(() => undefined);

export const postCompact = (ref: string, focus?: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/compact`, {
    method: "POST",
    body: focus ? { focus } : {},
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

export const postInterrupt = (ref: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/interrupt`, {
    method: "POST",
    body: {},
    schema: z.object({}),
  }).then(() => undefined);

export const postResetSession = (ref: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/reset-session`, {
    method: "POST",
    body: {},
    schema: z.object({}),
  }).then(() => undefined);

/** I7 §9.4: what the restart did (a 409 `lost_work` throws, its lists in the error's `body.data`). */
export const postRestart = (ref: string, { force }: { force?: boolean } = {}) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/restart`, {
    method: "POST",
    body: force ? { force: true } : {},
    schema: restartAgentResponseSchema,
  }).then((r) => r.status);

/** S7: terminate a spawned agent (idempotent: one already terminated comes back as it is). */
export const postTerminate = (ref: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/terminate`, {
    method: "POST",
    body: {},
    schema: agentResponseSchema,
  }).then((r) => r.agent);

/** S7: pin (PUT) or unpin (DELETE) a terminated agent's workspace. */
export const setWorkspacePin = (ref: string, pinned: boolean) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/workspace-pin`, {
    method: pinned ? "PUT" : "DELETE",
    schema: agentResponseSchema,
  }).then((r) => r.agent);
