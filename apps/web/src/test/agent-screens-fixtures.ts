import type { AgentSummary, TemplateConfig } from "@open-factory/shared";
import { type Handler, json, type MockApi, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";

export { agentSummary };

export const credential = (name = "work", kind: "oauth_token" | "api_key" = "oauth_token") => ({
  name,
  kind,
  lastVerifiedAt: "2026-11-19T08:00:00.000Z",
  lastError: null,
  expiresAt: null,
  rejected: false,
  usedBy: [],
  archivedUsedBy: [],
  rateLimit: null,
});

export const project = (name: string, hostPath = `/src/${name}`) => ({
  name,
  hostPath,
  grantedTo: [],
  archivedGrantedTo: [],
  templates: [],
});

export const templateSummary = (name: string, errors = 0) => ({
  name,
  displayName: name,
  description: "",
  runtime: "local",
  errors,
  warnings: 0,
  agentCount: 0,
});

export const templateConfig = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({
  name: "lead",
  displayName: "Team Lead",
  description: "Leads the team",
  runtime: "local",
  permissionMode: "auto",
  projects: ["app"],
  skills: [],
  localSkills: true,
  secrets: [],
  canSpawn: [],
  ...over,
});

export const templateDetail = (config: TemplateConfig | undefined, issues: unknown[] = []) => ({
  template: {
    name: config?.name ?? "lead",
    path: `/h/of/templates/${config?.name ?? "lead"}`,
    config,
    files: [],
    issues,
    agents: [],
    avatar: { version: null, tooLarge: false },
  },
});

export interface World {
  agents?: AgentSummary[];
  archived?: AgentSummary[];
  credentials?: ReturnType<typeof credential>[];
  templates?: ReturnType<typeof templateSummary>[];
  details?: Record<string, ReturnType<typeof templateDetail>>;
  projects?: ReturnType<typeof project>[];
  secrets?: { name: string; updatedAt: string; usedBy: string[] }[];
  users?: unknown[];
  extra?: Record<string, Handler>;
}

/** A ready world: one credential, one valid template `lead` granting `app`, two projects. */
export function mockWorld(w: World = {}): MockApi {
  const agents = w.agents ?? [];
  const routes: Record<string, Handler> = {
    "GET /api/agents?ended=exclude": () => json({ agents, running: { count: 0, max: 8 } }),
    "GET /api/agents?ended=only": () =>
      json({ agents: w.archived ?? [], running: { count: 0, max: 8 } }),
    "GET /api/credentials": () => json({ credentials: w.credentials ?? [credential()] }),
    "GET /api/templates": () =>
      json({ dir: "/h/of/templates", templates: w.templates ?? [templateSummary("lead")] }),
    "GET /api/projects": () => json({ projects: w.projects ?? [project("app"), project("docs")] }),
    "GET /api/secrets": () => json({ secrets: w.secrets ?? [] }),
    "GET /api/users": () => json({ users: w.users ?? [] }),
  };
  const details = w.details ?? { lead: templateDetail(templateConfig()) };
  for (const [name, d] of Object.entries(details))
    routes[`GET /api/templates/${name}`] = () => json(d);
  for (const a of [...agents, ...(w.archived ?? [])]) {
    routes[`GET /api/agents/${a.slug}`] = () =>
      json({ agent: a, model: { value: null, source: "default" }, queue: [], lastSeq: 0 });
  }
  return mockApi({ ...routes, ...w.extra });
}
