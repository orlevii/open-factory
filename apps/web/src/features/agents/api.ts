import {
  agentResponseSchema,
  apiFetch,
  type CreateAgentBody,
  type PatchAgentBody,
  resyncResponseSchema,
} from "@open-factory/shared";

// The list query lives with the session API (it feeds the shell and the session screens):
export { agentsListQueryOptions } from "@/features/session/api";

const path = (slug: string) => `/api/agents/${encodeURIComponent(slug)}`;
const post = (slug: string, action: string) =>
  apiFetch(`${path(slug)}/${action}`, {
    method: "POST",
    body: {},
    schema: agentResponseSchema,
  }).then((r) => r.agent);

export const createAgent = (body: CreateAgentBody) =>
  apiFetch("/api/agents", { method: "POST", body, schema: agentResponseSchema }).then(
    (r) => r.agent,
  );

export const updateAgent = (slug: string, body: PatchAgentBody) =>
  apiFetch(path(slug), { method: "PATCH", body, schema: agentResponseSchema }).then((r) => r.agent);

export const resyncAgent = (slug: string) =>
  apiFetch(`${path(slug)}/resync`, { method: "POST", body: {}, schema: resyncResponseSchema });

export const archiveAgent = (slug: string) => post(slug, "archive");
export const unarchiveAgent = (slug: string) => post(slug, "unarchive");
