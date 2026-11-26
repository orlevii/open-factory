import {
  type AgentConfigResponse,
  agentConfigResponseSchema,
  apiFetch,
  type PutAgentConfigBody,
  type PutAgentConfigResponse,
  type PutTemplateConfigBody,
  putAgentConfigResponseSchema,
  putTemplateConfigResponseSchema,
  templateConfigResponseSchema,
} from "@open-factory/shared";
import { mutationOptions, type QueryClient, queryOptions } from "@tanstack/react-query";

const agentPath = (ref: string) => `/api/agents/${encodeURIComponent(ref)}/config`;
const templatePath = (name: string) => `/api/templates/${encodeURIComponent(name)}/config`;

// staleTime 0: a save sends the loaded version back, and a stale cache would answer with a 409.
export const agentConfigQueryOptions = (ref: string) =>
  queryOptions({
    queryKey: ["agent-config", ref],
    queryFn: () => apiFetch(agentPath(ref), { schema: agentConfigResponseSchema }),
    staleTime: 0,
  });

export const templateConfigQueryOptions = (name: string) =>
  queryOptions({
    queryKey: ["template-config", name],
    queryFn: () => apiFetch(templatePath(name), { schema: templateConfigResponseSchema }),
    staleTime: 0,
  });

export const putAgentConfig = (ref: string, body: PutAgentConfigBody) =>
  apiFetch(agentPath(ref), { method: "PUT", body, schema: putAgentConfigResponseSchema });

export const putTemplateConfig = (name: string, body: PutTemplateConfigBody) =>
  apiFetch(templatePath(name), { method: "PUT", body, schema: putTemplateConfigResponseSchema });

/** The page's Save (spec §12.4). The page writes the response into the cache itself, in the same tick as it settles the
 *  draft (`cacheSavedAgentConfig`), so no render sees the saved version beside the unsaved draft. */
export const saveAgentConfigMutation = (ref: string) =>
  mutationOptions({
    mutationKey: ["agent-config", ref, "save"],
    mutationFn: (body: PutAgentConfigBody) => putAgentConfig(ref, body),
  });

/** After a save: the response is the new GET, so it replaces the cache with no refetch. */
export function cacheSavedAgentConfig(qc: QueryClient, ref: string, r: PutAgentConfigResponse) {
  const { changes: _c, restartChecked: _r, checked: _k, ...view } = r;
  qc.setQueryData<AgentConfigResponse>(agentConfigQueryOptions(ref).queryKey, view);
}
