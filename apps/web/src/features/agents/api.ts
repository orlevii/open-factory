import {
  ApiError,
  agentResponseSchema,
  apiFetch,
  type CreateAgentBody,
  type PatchAgentBody,
  resetPersonaResponseSchema,
} from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import {
  agentConfigQueryOptions,
  cacheSavedAgentConfig,
  putAgentConfig,
} from "@/features/config/api";
import { setAt } from "@/features/config/tolerant";

// The list query lives with the session API (it feeds the shell and the session screens):
export { agentsListQueryOptions } from "@/features/session/api";

const path = (ref: string) => `/api/agents/${encodeURIComponent(ref)}`;
const post = (ref: string, action: string) =>
  apiFetch(`${path(ref)}/${action}`, {
    method: "POST",
    body: {},
    schema: agentResponseSchema,
  }).then((r) => r.agent);

export const createAgent = (body: CreateAgentBody) =>
  apiFetch("/api/agents", { method: "POST", body, schema: agentResponseSchema }).then(
    (r) => r.agent,
  );

export const updateAgent = (ref: string, body: PatchAgentBody) =>
  apiFetch(path(ref), { method: "PATCH", body, schema: agentResponseSchema }).then((r) => r.agent);

export const resetPersona = (ref: string) =>
  apiFetch(`${path(ref)}/reset-persona`, {
    method: "POST",
    body: {},
    schema: resetPersonaResponseSchema,
  });

export const archiveAgent = (ref: string) => post(ref, "archive");
export const unarchiveAgent = (ref: string) => post(ref, "unarchive");

/** An agent's own model and effort, "" for inherit. */
export type ModelEffort = { model: string; effort: string };

/**
 * Writes the agent's model and effort into its overlay (`template.model`, `template.effort`), keeping every other
 * key of it. A running agent restarts at its turn end with `--resume`: the existing config-change path. The overlay
 * is read fresh and sent with its version; a save someone else made in between gets one more try on the new version.
 */
export async function saveModelEffort(qc: QueryClient, ref: string, v: ModelEffort) {
  for (let attempt = 0; ; attempt++) {
    const current = await qc.fetchQuery(agentConfigQueryOptions(ref));
    let overlay = setAt(current.overlay, ["template", "model"], v.model || undefined);
    overlay = setAt(overlay, ["template", "effort"], v.effort || undefined);
    try {
      const saved = await putAgentConfig(ref, { overlay, baseVersion: current.version });
      cacheSavedAgentConfig(qc, ref, saved);
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent", ref] });
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof ApiError && err.code === "config_changed") continue;
      throw err;
    }
  }
}
