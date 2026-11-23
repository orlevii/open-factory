import {
  type AgentSummary,
  ApiError,
  agentDetailSchema,
  agentListSchema,
  agentResponseSchema,
  apiFetch,
  eventsPageSchema,
  messageLookupSchema,
  queueItemResponseSchema,
  sendMessagesResponseSchema,
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

/** Outside the ["agents"] prefix: every value under it is an agent array (status-frames.ts). */
export const endedMoreQueryKey = ["ended-more"] as const;
/** Filled by the ended list's fetch only (`skipToken`: it never fetches on its own). */
export const endedMoreQueryOptions = queryOptions<boolean>({
  queryKey: endedMoreQueryKey,
  queryFn: skipToken,
  staleTime: Number.POSITIVE_INFINITY,
});

/** Running agents and the cap, live from the `supervisor` frame (folded in by status-frames.ts). */
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
    // Guarded: a non-list value under the prefix must not throw during render or a socket frame.
    const hit = Array.isArray(list) ? list.find((a) => a.slug === slug) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

export function fetchEvents(
  slug: string,
  q: { before?: number; around?: number; limit?: number } = {},
  signal?: AbortSignal,
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return apiFetch(`/api/agents/${encodeURIComponent(slug)}/events?${p}`, {
    schema: eventsPageSchema,
    signal,
  });
}

export const fetchMessage = (id: string) =>
  apiFetch(`/api/messages/${encodeURIComponent(id)}`, { schema: messageLookupSchema });

/**
 * `POST /api/messages` to one agent. U3 §13.2: `clientMessageId` makes a retry idempotent. The recipient's result
 * is the call's: a refusal or a failed start throws as the per-agent route's errors did.
 */
export const postMessage = async (
  slug: string,
  body: string,
  o: { urgent: boolean; clientMessageId?: string; attachments?: string[]; signal?: AbortSignal },
) => {
  const { results } = await apiFetch("/api/messages", {
    method: "POST",
    body: {
      to: [slug],
      body,
      urgent: o.urgent,
      ...(o.clientMessageId ? { clientMessageId: o.clientMessageId } : {}),
      ...(o.attachments?.length ? { attachments: o.attachments } : {}),
    },
    schema: sendMessagesResponseSchema,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const r = results[0];
  if (r?.status === "queued" && r.item) return r.item;
  const reason = r?.reason ?? "The message wasn't sent.";
  if (r?.status === "start_failed") throw new ApiError(503, "agent_start_failed", reason);
  const code = /archived/.test(reason)
    ? "agent_archived"
    : /terminated/.test(reason)
      ? "agent_terminated"
      : "agent_not_found";
  throw new ApiError(409, code, reason);
};

/** `POST /api/agents/:slug/input`: the raw text a human types into the session, exactly as typed (I1 §5.1).
 *  `clientMessageId` makes a retry idempotent. */
export const postInput = (
  slug: string,
  body: { text: string; clientMessageId: string },
  signal?: AbortSignal,
) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/input`, {
    method: "POST",
    body,
    schema: queueItemResponseSchema,
    ...(signal ? { signal } : {}),
  }).then((r) => r.item);

/** U3 §6.4: withdraw a held message you sent; resolves to the cancelled item. */
export const cancelQueued = (slug: string, messageId: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/queue/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

/** U3 §6.4: Undo of a cancel (204); the restored item arrives in the next `queue` frame. */
export const restoreQueued = (slug: string, messageId: string) =>
  apiFetch(
    `/api/agents/${encodeURIComponent(slug)}/queue/${encodeURIComponent(messageId)}/restore`,
    { method: "POST", body: {}, schema: z.unknown() },
  ).then(() => undefined);

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
