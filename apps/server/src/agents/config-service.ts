import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type Actor,
  type AgentConfigResponse,
  type AgentOverlay,
  agentOverlaySchema,
  agentPolicyIssues,
  type ConfigDoc,
  LOCAL_RUNTIME_REFUSAL,
  mergeConfig,
  overlayVersion,
  type PutAgentConfigResponse,
  type TemplateIssue,
  touchesLocalRuntime,
  yamlPart,
} from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { ApiError } from "../errors.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { overlayIssues, overlaySchemaIssues } from "../templates/validate.ts";
import type { ConfigChanges } from "./config-changes.ts";
import { OrgRefusedError } from "./errors.ts";
import type { Tx } from "./event-store.ts";
import type { PolicyInputs } from "./policy-inputs.ts";

type Base = { doc: ConfigDoc; dir: string } | null;

/** What `planOverlay` validated: `write` runs in the caller's transaction (which holds the row lock), `after` once it commits. */
export type OverlayPlan = {
  row: AgentRow;
  overlay: AgentOverlay;
  write(tx: Tx, locked: AgentRow): Promise<void>;
  after(): Promise<PutAgentConfigResponse>;
};

/** An agent's configuration: the overlay over its template, read (`GET …/config`) and saved (`PUT …/config`, I2 §12.1). */
export class ConfigService {
  constructor(
    private readonly d: {
      db: Db;
      templates: TemplateIndex;
      policy: PolicyInputs;
      configChanges: Pick<ConfigChanges, "overlaySaved">;
    },
  ) {}

  private notFound(slug: string) {
    return new ApiError(404, "agent_not_found", `No agent named ${slug}`);
  }

  private async rowBySlug(slug: string): Promise<AgentRow> {
    const [row] = await this.d.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
    if (!row) throw this.notFound(slug);
    return row;
  }

  /** The overlay as stored; one that fails its schema (an agent made before I2) is kept as is for the editor to fix. */
  private overlayOf(row: AgentRow): Record<string, unknown> {
    return row.config as Record<string, unknown>;
  }

  /**
   * The template's current valid doc and folder, or null while it is invalid or missing (an agent's config is then
   * checked against the schema alone, spec §12.1). Never a template's issues: those are fixed in Templates.
   */
  private async templateBase(name: string): Promise<Base> {
    try {
      const { doc, dir } = await this.d.templates.loadValid(name);
      return { doc, dir };
    } catch (err) {
      if (err instanceof ApiError && ["template_missing", "template_invalid"].includes(err.code))
        return null;
      throw err;
    }
  }

  /** What an editor may see of a doc: `local_skill_names` is derived and internal, never offered for editing. */
  private forEditing(doc: ConfigDoc): ConfigDoc {
    return { ...doc, template: yamlPart(doc.template) };
  }

  /** The issues of an overlay against the template (warnings and errors); the schema alone when there is no base. */
  private async configIssues(row: AgentRow, overlay: unknown, base: Base) {
    const parsed = agentOverlaySchema.safeParse(overlay);
    if (!parsed.success || !base) return overlaySchemaIssues(overlay);
    const ctx = {
      ...(await this.d.templates.context()),
      templateDir: base.dir,
      agentRuntimes: [row.runtime],
    };
    return overlayIssues(base.doc, parsed.data, ctx);
  }

  /** I2 §12.1 `GET /api/agents/:slug/config`. */
  async getConfig(slug: string): Promise<AgentConfigResponse> {
    const row = await this.rowBySlug(slug);
    const overlay = this.overlayOf(row);
    const base = await this.templateBase(row.template);
    return this.configView(row, overlay, base, await this.configIssues(row, overlay, base));
  }

  private configView(
    row: AgentRow,
    overlay: Record<string, unknown>,
    base: { doc: ConfigDoc } | null,
    issues: AgentConfigResponse["issues"],
  ): AgentConfigResponse {
    const parsed = agentOverlaySchema.safeParse(overlay);
    // The agent's runtime, not the template's: it is fixed per agent (only a human switches it), and a template change
    // never moves it.
    const merged =
      base && parsed.success
        ? withRuntime(mergeConfig(base.doc, parsed.data), row.runtime)
        : null;
    return {
      overlay,
      version: overlayVersion(overlay as AgentOverlay),
      template: {
        name: row.template,
        doc: base ? this.forEditing(base.doc) : null,
        valid: base !== null,
      },
      merged: merged ? this.forEditing(merged) : null,
      issues,
    };
  }

  /** A stale `baseVersion`: a human reopens the editor; an agent is told to read the agent again (spec §7.5). */
  private staleRefusal(row: AgentRow, actor: Actor): ApiError {
    return actor.kind === "agent"
      ? new OrgRefusedError(
          `@${row.slug}'s configuration changed since you read it; call get_agent again.`,
        )
      : new ApiError(409, "config_changed", "Changed since you opened it.");
  }

  /** The agent policy's issues for an overlay save (spec §6.2): `before` is the stored overlay. */
  private policyIssues(row: AgentRow, overlay: AgentOverlay): TemplateIssue[] {
    const stored = agentOverlaySchema.safeParse(this.overlayOf(row));
    return agentPolicyIssues({
      target: "overlay",
      before: stored.success ? stored.data : {},
      after: overlay,
    });
  }

  /** Rule 8: an agent never reaches a local runtime, as the target or through a `can_spawn` name. */
  private async assertNotLocal(row: AgentRow, overlay: unknown, actor: Actor) {
    if (actor.kind !== "agent") return;
    const raw: unknown = (overlay as AgentOverlay | undefined)?.template?.can_spawn;
    const spawns = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
    const canSpawnRuntimes = await this.d.policy.templateRuntimes(spawns);
    if (touchesLocalRuntime({ agentRuntime: row.runtime, canSpawnRuntimes }))
      throw new OrgRefusedError(LOCAL_RUNTIME_REFUSAL);
  }

  /**
   * Validates a PUT outside any transaction (disk and Library reads) and returns its writes: `write(tx, locked)` runs
   * in the caller's transaction after it locked the row, compares the JS-computed versions (Postgres' `jsonb::text`
   * doesn't sort keys the way the canonical form does, so the version is never computed in SQL) and writes; `after()`
   * schedules the restart check, never awaits it (spec §7.2). Issues carry paths and constant messages, never a value.
   */
  async planOverlay(
    slug: string,
    overlayInput: unknown,
    baseVersion: string,
    actor: Actor,
  ): Promise<OverlayPlan> {
    const row = await this.rowBySlug(slug);
    if (row.kind === "ephemeral")
      throw new ApiError(
        409,
        "ephemeral_agent",
        "Spawned agents can't be edited; terminate it instead.",
      );
    await this.assertNotLocal(row, overlayInput, actor);
    const isStale = (r: AgentRow) =>
      overlayVersion(this.overlayOf(r) as AgentOverlay) !== baseVersion;
    if (isStale(row)) throw this.staleRefusal(row, actor);

    const parsed = agentOverlaySchema.safeParse(overlayInput);
    const base = await this.templateBase(row.template);
    const issues = await this.configIssues(row, overlayInput, base);
    if (parsed.success && actor.kind === "agent")
      issues.push(...this.policyIssues(row, parsed.data));
    if (!parsed.success || issues.some((i) => i.severity === "error"))
      throw new ApiError(400, "invalid_config", "The configuration has errors.", { issues });
    const overlay = parsed.data;

    let before: Record<string, unknown> = {};
    return {
      row,
      overlay,
      write: async (tx, locked) => {
        if (isStale(locked)) throw this.staleRefusal(locked, actor);
        before = this.overlayOf(locked);
        await tx.update(schema.agents).set({ config: overlay }).where(eq(schema.agents.id, row.id));
      },
      after: async () => {
        let applied: { changes: string[]; restartChecked: boolean } = {
          changes: [],
          restartChecked: false,
        };
        // A broken template has no effective config to diff or restart into; the next start reads everything fresh.
        if (base) {
          const was = agentOverlaySchema.safeParse(before);
          applied = await this.d.configChanges.overlaySaved(
            { ...row, config: overlay },
            actor,
            mergeConfig(base.doc, was.success ? was.data : {}),
            mergeConfig(base.doc, overlay),
          );
        }
        return {
          ...this.configView({ ...row, config: overlay }, overlay, base, issues),
          ...applied,
          checked: base ? "full" : "schema",
        };
      },
    };
  }

  /** I2 §12.1 `PUT /api/agents/:slug/config`: `planOverlay`, one transaction that locks the row, then `after`. */
  async saveOverlay(
    slug: string,
    overlay: unknown,
    baseVersion: string,
    actor: Actor,
  ): Promise<PutAgentConfigResponse> {
    const plan = await this.planOverlay(slug, overlay, baseVersion, actor);
    await this.d.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, plan.row.id))
        .for("no key update");
      if (!locked) throw this.notFound(slug);
      await plan.write(tx, locked);
    });
    return plan.after();
  }
}

const withRuntime = (doc: ConfigDoc, runtime: AgentRow["runtime"]): ConfigDoc => ({
  ...doc,
  template: { ...doc.template, runtime },
});
