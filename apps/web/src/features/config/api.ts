import {
  agentConfigResponseSchema,
  apiFetch,
  hostSkillsResponseSchema,
  type PutAgentConfigBody,
  type PutTemplateConfigBody,
  putAgentConfigResponseSchema,
  putTemplateConfigResponseSchema,
  templateConfigResponseSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";

const agentPath = (slug: string) => `/api/agents/${encodeURIComponent(slug)}/config`;
const templatePath = (name: string) => `/api/templates/${encodeURIComponent(name)}/config`;

// staleTime 0: a save sends the loaded version back, and a stale cache would answer with a 409.
export const agentConfigQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ["agent-config", slug],
    queryFn: () => apiFetch(agentPath(slug), { schema: agentConfigResponseSchema }),
    staleTime: 0,
  });

export const templateConfigQueryOptions = (name: string) =>
  queryOptions({
    queryKey: ["template-config", name],
    queryFn: () => apiFetch(templatePath(name), { schema: templateConfigResponseSchema }),
    staleTime: 0,
  });

/** Read live (spec §12.1); feeds the skills picker until I5's Library replaces it. */
export const hostSkillsQueryOptions = queryOptions({
  queryKey: ["host-skills"],
  queryFn: () => apiFetch("/api/host-skills", { schema: hostSkillsResponseSchema }),
  staleTime: 0,
});

export const putAgentConfig = (slug: string, body: PutAgentConfigBody) =>
  apiFetch(agentPath(slug), { method: "PUT", body, schema: putAgentConfigResponseSchema });

export const putTemplateConfig = (name: string, body: PutTemplateConfigBody) =>
  apiFetch(templatePath(name), { method: "PUT", body, schema: putTemplateConfigResponseSchema });
