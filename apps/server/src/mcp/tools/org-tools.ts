import type { AgentRow } from "@open-factory/db";
import {
  type Actor,
  createAgentToolSchema,
  getAgentToolSchema,
  getTemplateToolSchema,
  LIBRARY_LIST_MAX,
  listLibraryToolSchema,
  type PatchAgentBody,
  updateAgentToolSchema,
} from "@open-factory/shared";
import { z } from "zod";
import type { AgentService } from "../../agents/agent-service.ts";
import type { ConfigService } from "../../agents/config-service.ts";
import { OrgRefusedError } from "../../agents/errors.ts";
import type { CredentialService } from "../../credentials/credential-service.ts";
import type { LibraryIndex } from "../../library/library-index.ts";
import type { PluginsIndex } from "../../library/plugins-index.ts";
import type { ProjectService } from "../../projects/project-service.ts";
import type { SecretService } from "../../secrets/secret-service.ts";
import type { TemplateIndex } from "../../templates/template-index.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
} from "../server.ts";
import { toolErrorOf } from "./org-errors.ts";

export type OrgToolDeps = {
  loadAgent(id: string): Promise<AgentRow | undefined>;
  agents: AgentService;
  config: ConfigService;
  templates: TemplateIndex;
  library: LibraryIndex;
  plugins: PluginsIndex;
  credentials: CredentialService;
  secrets: SecretService;
  projects: ProjectService;
};

type AgentActor = Extract<Actor, { kind: "agent" }>;

const bare = (slug: string) => slug.trim().replace(/^@/, "");
const matches = (query: string | undefined, ...texts: (string | undefined)[]) => {
  const q = query?.trim().toLowerCase();
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
};
const shortPin = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : null);

/**
 * The org tools (I7 §7.1), registered only for a `manage_org` caller (§5.2). Results are one text block of compact
 * JSON. Every handler first re-reads the caller (the second gate), then calls the service the human route calls with
 * the agent `Actor`; a service refusal is the same sentence a human gets (`toolErrorOf`). No result holds a secret or
 * credential value or a host path: they return names, references and hashes only.
 */
export function orgTools(d: OrgToolDeps): ToolRegistration[] {
  /** The call-time check: the caller must still exist, be live and hold the flag. */
  const actorOf = async (tctx: ToolContext): Promise<AgentActor> => {
    const row = await d.loadAgent(callerOf(tctx));
    if (!row || row.archivedAt || row.terminatedAt || !row.manageOrg)
      throw new OrgRefusedError(row ? `@${row.slug} can't manage the org any more.` : "You can't manage the org any more.");
    return { kind: "agent", id: row.id, slug: row.slug };
  };
  const handler =
    <A>(fn: (args: A, actor: AgentActor) => Promise<unknown>) =>
    async (args: A, tctx: ToolContext) => {
      try {
        return textResult(await fn(args, await actorOf(tctx)));
      } catch (err) {
        return toolErrorOf(err);
      }
    };
  /** `"me"` and an omitted manager are the caller; null is top level. */
  const managerOf = (actor: AgentActor, m: string | null | undefined): string | null =>
    m === null ? null : m === undefined || bare(m) === "me" ? actor.slug : bare(m);

  const tool = <S extends z.ZodType>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<S>, actor: AgentActor) => Promise<unknown>,
  ): ToolRegistration => ({
    register(server: McpServer) {
      // The SDK's overloads can't resolve a generic schema; its input type is `z.infer<S>`, which `handler` takes.
      server.registerTool(
        name,
        { description, inputSchema: inputSchema as z.ZodType<z.infer<S>> },
        handler(run),
      );
    },
  });
  const noArgs = z.object({});

  return [
    tool(
      "list_templates",
      "List the agent templates: name, display name, description, whether it is valid and how many agents use it.",
      noArgs,
      async () => {
        const [rows, counts] = await Promise.all([d.templates.scan(), d.templates.agentCounts()]);
        return rows.map((r) => ({
          name: r.name,
          display_name: r.config?.displayName ?? r.name,
          description: r.config?.description ?? "",
          valid: !r.issues.some((i) => i.severity === "error"),
          agents: counts.get(r.name) ?? 0,
        }));
      },
    ),
    tool(
      "get_template",
      "Read a template's four files (template.yaml, settings.json, mcp.json, AGENTS.md) with their hashes, its issues and the agents that use it.",
      getTemplateToolSchema,
      async ({ name }) => {
        const v = await d.templates.orgView(name.trim());
        return { name: name.trim(), ...v };
      },
    ),
    tool(
      "get_agent",
      "Read an agent: its identity, manager, credential and projects by name, its overlay with overlay_hash (pass it back as base_hash to change config), its effective configuration (references, never values), plugins and issues.",
      getAgentToolSchema,
      async ({ slug }) => {
        const s = bare(slug);
        const [a, cfg] = await Promise.all([d.agents.summary(s), d.config.getConfig(s)]);
        return {
          slug: a.slug,
          display_name: a.displayName,
          description: a.description,
          kind: a.kind,
          template: a.template,
          manager: a.reportsTo,
          credential: a.credential,
          projects: a.projects,
          manage_org: a.manageOrg,
          status: a.status,
          archived: a.archivedAt !== null,
          overlay: cfg.overlay,
          overlay_hash: cfg.version,
          effective: cfg.merged,
          plugins: cfg.plugins,
          issues: cfg.issues,
        };
      },
    ),
    tool(
      "create_agent",
      'Create a persistent agent from a template, the way a human does in New agent. The manager defaults to you ("me"); null makes it top level. It never gets manage_org.',
      createAgentToolSchema,
      async (a, actor) => {
        const slug = bare(a.name);
        await d.agents.create(
          {
            template: a.template.trim(),
            slug,
            displayName: a.display_name,
            description: a.description,
            reportsTo: managerOf(actor, a.manager),
            credential: a.credential.trim(),
            ...(a.projects ? { projects: a.projects } : {}),
            ...(a.config ? { config: a.config } : {}),
          },
          actor,
        );
        return {
          slug,
          status: "created",
          note: `@${slug} is created and starts when it gets its first message.`,
        };
      },
    ),
    tool(
      "update_agent",
      "Change an agent. A field you leave out is unchanged. config is the WHOLE new overlay and needs base_hash (the overlay_hash from get_agent). Everything is validated first and written together, or nothing is. The result's restart is a hint that a restart was requested, not a guarantee (an errored or hibernated agent does not restart).",
      updateAgentToolSchema,
      async (a, actor) => {
        const slug = bare(a.slug);
        const before = await d.agents.summary(slug);
        const patch: PatchAgentBody = {
          ...(a.display_name !== undefined ? { displayName: a.display_name } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.manager !== undefined ? { reportsTo: managerOf(actor, a.manager) } : {}),
          ...(a.credential !== undefined ? { credential: a.credential.trim() } : {}),
          ...(a.projects !== undefined ? { projects: a.projects } : {}),
        };
        const plan =
          a.config !== undefined && a.base_hash !== undefined
            ? await d.config.planOverlay(slug, a.config, a.base_hash, actor)
            : undefined;
        const r = await d.agents.updateWithOverlay(slug, patch, plan, actor);
        const same = (x: string[], y: string[]) =>
          [...x].sort().join("\0") === [...y].sort().join("\0");
        const fields: string[] = [
          ...(r.agent.displayName !== before.displayName ? ["display_name"] : []),
          ...(r.agent.description !== before.description ? ["description"] : []),
          ...(r.agent.reportsTo !== before.reportsTo ? ["manager"] : []),
          ...(r.agent.credential !== before.credential ? ["credential"] : []),
          ...(same(r.agent.projects, before.projects) ? [] : ["projects"]),
        ];
        const lines = r.config?.changes ?? [];
        const identity = fields.length > 0;
        const changed = lines.length ? [...fields, "config", ...lines] : fields;
        const restart =
          (r.config?.restartChecked ?? false) ||
          (identity && !before.archivedAt && before.status !== "hibernated");
        return {
          slug,
          changed,
          restart,
          ...(r.config?.checked === "schema"
            ? { note: `Checked fully once ${before.template} is fixed.` }
            : {}),
        };
      },
    ),
    tool(
      "archive_agent",
      "Archive an agent (not yourself). Refused while it has reports; the refusal names them.",
      getAgentToolSchema,
      async ({ slug }, actor) => {
        const a = await d.agents.archive(bare(slug), actor);
        return { slug: a.slug, archived: true };
      },
    ),
    tool(
      "unarchive_agent",
      "Unarchive an agent. Refused when its manager is archived, or when it can manage the org.",
      getAgentToolSchema,
      async ({ slug }, actor) => {
        const a = await d.agents.unarchive(bare(slug), actor);
        return { slug: a.slug, archived: false };
      },
    ),
    tool(
      "list_library",
      "List the Library's skills, the plugins of its registered marketplaces (with whether a pin can hold them) and the marketplaces. Narrow with query.",
      listLibraryToolSchema,
      async ({ query }) => {
        const [groups, listed, registry] = await Promise.all([
          d.library.skills(),
          d.plugins.list(),
          d.library.marketplaces(),
        ]);
        const skills = groups.flatMap((g) => {
          const source =
            g.kind === "host"
              ? "host"
              : g.kind === "source"
                ? g.source.kind
                : g.kind === "template"
                  ? `template:${g.template}`
                  : "unknown";
          const pin = g.kind === "source" ? shortPin(g.source.pin) : null;
          return g.skills
            .filter((s) => matches(query, s.name, s.description))
            .map((s) => ({
              name: s.name,
              description: s.description,
              source,
              ...(pin ? { pin } : {}),
              state: s.state,
            }));
        });
        const plugins = listed.marketplaces.flatMap((m) =>
          m.plugins
            .filter((p) => matches(query, p.name, p.description))
            .map((p) => ({
              key: p.key,
              version: p.version ?? null,
              marketplace: m.name,
              pinnable: p.pinnable,
              state: p.state,
              contents: p.contentsSummary,
            })),
        );
        const marketplaces = registry
          .filter((r) => matches(query, r.name))
          .map((r) => ({
            name: r.name,
            kind: r.source.source,
            pin: r.source.source === "directory" ? null : shortPin(r.commit),
          }));
        const more =
          skills.length > LIBRARY_LIST_MAX ||
          plugins.length > LIBRARY_LIST_MAX ||
          marketplaces.length > LIBRARY_LIST_MAX;
        return {
          skills: skills.slice(0, LIBRARY_LIST_MAX),
          plugins: plugins.slice(0, LIBRARY_LIST_MAX),
          marketplaces: marketplaces.slice(0, LIBRARY_LIST_MAX),
          ...(more
            ? {
                more: true,
                note: `Showing the first ${LIBRARY_LIST_MAX} of a list; narrow query.`,
              }
            : {}),
        };
      },
    ),
    tool(
      "list_org_resources",
      "List the credentials (name and kind), secrets (name and how many use it) and projects you can give an agent, by name. Never values or paths.",
      noArgs,
      async () => {
        const [credentials, secrets, projects] = await Promise.all([
          d.credentials.list(),
          d.secrets.list(),
          d.projects.list(),
        ]);
        return {
          credentials: credentials.map((c) => ({ name: c.name, kind: c.kind })),
          secrets: secrets.map((s) => ({ name: s.name, used_by: s.usedBy.length })),
          projects: projects.map((p) => ({ name: p.name })),
        };
      },
    ),
  ];
}
