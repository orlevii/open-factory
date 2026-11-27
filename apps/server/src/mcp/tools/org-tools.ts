import {
  type Actor,
  actorBy,
  createAgentToolSchema,
  createTemplateToolSchema,
  getAgentToolSchema,
  getTemplateToolSchema,
  LIBRARY_LIST_MAX,
  listLibraryToolSchema,
  type PatchAgentBody,
  updateAgentToolSchema,
  writeTemplateFileToolSchema,
} from "@open-factory/shared";
import { agentMentionOf } from "@open-factory/shared/mentions";
import { z } from "zod";
import type { AgentService } from "../../agents/agent-service.ts";
import type { ConfigService } from "../../agents/config-service.ts";
import { OrgRefusedError } from "../../agents/errors.ts";
import type { EventBus } from "../../agents/event-bus.ts";
import type { CredentialService } from "../../credentials/credential-service.ts";
import { ApiError } from "../../errors.ts";
import type { LibraryIndex } from "../../library/library-index.ts";
import type { AgentRecord } from "../../principals/principal-store.ts";
import type { AgentFacing } from "../../principals/principal-text.ts";
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
  loadAgent(id: string): Promise<AgentRecord | undefined>;
  /** The caller's principal ref: the agent actor is named by its mention in stored text. */
  principalRef(id: string): Promise<string | undefined>;
  /** Mentions for the handles a result names and a renderer for the stored text it returns (spec §4.4). */
  facing(want: { handles?: readonly string[]; texts?: readonly string[] }): Promise<AgentFacing>;
  agents: AgentService;
  config: ConfigService;
  templates: TemplateIndex;
  library: LibraryIndex;
  credentials: CredentialService;
  secrets: SecretService;
  projects: ProjectService;
  /** Template creation publishes its `org_action` toast here, after the commit (spec §8.3). */
  bus: Pick<EventBus, "publishAll">;
};

type AgentActor = Extract<Actor, { kind: "agent" }>;

/** `warnings` in a result only when there is one, deduplicated. */
const warned = (...w: (string | undefined)[]) => {
  const all = [...new Set(w.filter((x): x is string => !!x))];
  return all.length ? { warnings: all } : {};
};
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
      throw new OrgRefusedError(
        row
          ? `@${row.handle} can't manage the org any more.`
          : "You can't manage the org any more.",
      );
    const ref = await d.principalRef(row.id);
    if (!ref)
      throw new OrgRefusedError(
        `@${row.handle} has no principal; ask a human to check the factory.`,
      );
    return { kind: "agent", id: row.id, ref, handle: row.handle };
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
      "create_template",
      "Create a template: a new scaffold, or a copy of an existing one (from) with its files and skills. Returns its name and issues. Every human sees a toast.",
      createTemplateToolSchema,
      async (a, actor) => {
        const b = {
          name: a.name,
          displayName: a.display_name,
          ...(a.description !== undefined ? { description: a.description } : {}),
        };
        const { issues } =
          a.from !== undefined
            ? await d.templates.copyFrom(a.from, b, actor)
            : await d.templates.create(b, actor);
        d.bus.publishAll({
          type: "org_action",
          action: "template_created",
          by: actorBy(actor),
          subject: a.name,
        });
        return { name: a.name, issues };
      },
    ),
    tool(
      "write_template_file",
      "Replace one of a template's four files (template.yaml, settings.json, mcp.json, AGENTS.md) with the whole new content. base_hash is the hash get_template gave you for it; null only for a file that doesn't exist yet. A write that causes an error is refused whole, and runtime, image and permission mode are for humans. Returns the new hash and the template's issues.",
      writeTemplateFileToolSchema,
      async (a, actor) => {
        try {
          return await d.templates.writeFile(a.name, a.file, a.content, a.base_hash, actor);
        } catch (err) {
          // A stale hash is a 409 for humans; the agent is told which file to re-read.
          if (err instanceof ApiError && err.code === "changed_on_disk")
            throw new OrgRefusedError(
              `${a.file} changed since you read it; call get_template again.`,
            );
          throw err;
        }
      },
    ),
    tool(
      "get_agent",
      "Read an agent: its identity, manager, credential and projects by name, its overlay with overlay_hash (pass it back as base_hash to change config), its effective configuration (references, never values) and issues.",
      getAgentToolSchema,
      async ({ target }) => {
        const { ref, mention, warning } = await d.agents.agentOf(target);
        const [a, cfg] = await Promise.all([d.agents.summary(ref), d.config.getConfig(ref)]);
        const facing = await d.facing({ texts: [a.description] });
        return {
          handle: a.handle,
          mention,
          display_name: a.displayName,
          description: facing.render(a.description),
          kind: a.kind,
          template: a.template,
          reports_to: agentMentionOf(a.reportsTo),
          credential: a.credential,
          projects: a.projects,
          manage_org: a.manageOrg,
          status: a.status,
          archived: a.archivedAt !== null,
          overlay: cfg.overlay,
          overlay_hash: cfg.version,
          effective: cfg.merged,
          issues: cfg.issues,
          ...warned(warning),
        };
      },
    ),
    tool(
      "create_agent",
      "Create a persistent agent from a template, the way a human does in New agent. reports_to is required: an agent or a person, as <@ref|handle>. It never gets manage_org.",
      createAgentToolSchema,
      async (a, actor) => {
        const handle = a.handle.trim().replace(/^@/, "");
        const manager = await d.agents.managerHandleOf(a.reports_to);
        const mentionWarnings: string[] = [];
        await d.agents.create(
          {
            template: a.template.trim(),
            handle,
            displayName: a.display_name,
            description: a.description,
            reportsTo: manager.handle,
            credential: a.credential.trim(),
            ...(a.projects ? { projects: a.projects } : {}),
            ...(a.config ? { config: a.config } : {}),
          },
          actor,
          mentionWarnings,
        );
        const mention = (await d.facing({ handles: [handle] })).mention(handle);
        return {
          handle,
          mention,
          status: "created",
          note: `${mention} is created and starts when it gets its first message.`,
          ...warned(manager.warning, ...mentionWarnings),
        };
      },
    ),
    tool(
      "update_agent",
      "Change an agent. A field you leave out is unchanged. config replaces the agent's whole overlay, so start from the one get_agent returned and pass its overlay_hash as base_hash. Everything is validated first and written together, or nothing is. The result's restart is a hint that a restart was requested, not a guarantee (an errored or hibernated agent does not restart).",
      updateAgentToolSchema,
      async (a, actor) => {
        const { ref, handle, mention, warning } = await d.agents.agentOf(a.target);
        const manager =
          a.reports_to !== undefined ? await d.agents.managerHandleOf(a.reports_to) : undefined;
        const before = await d.agents.summary(ref);
        const patch: PatchAgentBody = {
          ...(a.display_name !== undefined ? { displayName: a.display_name } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.reports_to !== undefined ? { reportsTo: manager?.handle as string } : {}),
          ...(a.credential !== undefined ? { credential: a.credential.trim() } : {}),
          ...(a.projects !== undefined ? { projects: a.projects } : {}),
        };
        const plan =
          a.config !== undefined && a.base_hash !== undefined
            ? await d.config.planOverlay(ref, a.config, a.base_hash, actor)
            : undefined;
        const mentionWarnings: string[] = [];
        const r = await d.agents.updateWithOverlay(ref, patch, plan, actor, mentionWarnings);
        const same = (x: string[], y: string[]) =>
          [...x].sort().join("\0") === [...y].sort().join("\0");
        const fields: string[] = [
          ...(r.agent.displayName !== before.displayName ? ["display_name"] : []),
          ...(r.agent.description !== before.description ? ["description"] : []),
          ...(r.agent.reportsTo.handle !== before.reportsTo.handle ? ["reports_to"] : []),
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
          handle,
          mention,
          changed,
          restart,
          ...(r.config?.checked === "schema"
            ? { note: `Checked fully once ${before.template} is fixed.` }
            : {}),
          ...warned(warning, manager?.warning, ...mentionWarnings),
        };
      },
    ),
    tool(
      "archive_agent",
      "Archive an agent (not yourself). Refused while it has reports; the refusal names them.",
      getAgentToolSchema,
      async ({ target }, actor) => {
        const { ref, mention, warning } = await d.agents.agentOf(target);
        const a = await d.agents.archive(ref, actor);
        return {
          handle: a.handle,
          mention,
          archived: true,
          ...warned(warning),
        };
      },
    ),
    tool(
      "unarchive_agent",
      "Unarchive an agent. Refused when its manager is archived, or when it can manage the org.",
      getAgentToolSchema,
      async ({ target }, actor) => {
        const { ref, mention, warning } = await d.agents.agentOf(target);
        const a = await d.agents.unarchive(ref, actor);
        return {
          handle: a.handle,
          mention,
          archived: false,
          ...warned(warning),
        };
      },
    ),
    tool(
      "list_library",
      "List the Library's skills. Narrow with query.",
      listLibraryToolSchema,
      async ({ query }) => {
        const groups = await d.library.skills();
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
        const more = skills.length > LIBRARY_LIST_MAX;
        return {
          skills: skills.slice(0, LIBRARY_LIST_MAX),
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
