import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type AgentConfigResponse,
  type AgentModel,
  type AgentOverlay,
  type AgentSummary,
  agentOverlaySchema,
  type ConfigDoc,
  type CreateAgentBody,
  mergeConfig,
  nameSchema,
  overlayVersion,
  type PatchAgentBody,
  type PutAgentConfigBody,
  type PutAgentConfigResponse,
  slugSchema,
  treeOrder,
  yamlPart,
} from "@open-factory/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { isSlugUnique } from "../db-errors.ts";
import { ApiError, FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { liveAgent } from "../messaging/neighborhood.ts";
import { claimHandle, handleKind } from "../messaging/principals.ts";
import type { PeerChange, Router } from "../messaging/router.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import { WORKSPACE_GRACE_MS } from "../spawning/lifecycle.ts";
import { avatarStat } from "../templates/avatar.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { overlayIssues, overlaySchemaIssues } from "../templates/validate.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import { PluginInstallError } from "../workspace/plugins.ts";
import type { MaterializeCheck, Workspace } from "../workspace/workspace.ts";
import type { RuntimeLog } from "./agent-runtime.ts";
import type { ConfigChanges } from "./config-changes.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, Exec, Tx } from "./event-store.ts";
import type { AgentRuntimes } from "./runtimes.ts";

const slugTaken = () => new FieldError("slug", FIELD_MSG.slugTaken, "slug_taken");

function pluginFailure(err: unknown): unknown {
  if (err instanceof PluginInstallError)
    return new ApiError(502, "plugin_install_failed", err.message, { output: err.output });
  if (err instanceof WorkspaceError) return new ApiError(409, "template_invalid", err.message);
  return err;
}

/** S7 §9.3: a spawner's live spawned agents block its archive; terminate them, don't move them. */
function spawnedMessage(spawner: string, slugs: string[]): string {
  return `@${spawner} has live spawned agents: ${slugs.map((s) => `@${s}`).join(", ")}. Terminate them first.`;
}

function reportsMessage(slugs: string[]): string {
  const tags = slugs.map((s) => `@${s}`);
  const who =
    tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}`;
  return `${who} ${tags.length === 1 ? "reports" : "report"} to this agent. Change their manager first.`;
}

/** The ended list's cap (S7 §14): the newest 200; one more row is read to know whether older ones exist. */
export const ENDED_LIST_LIMIT = 200;

/**
 * The ended agents (archived or terminated), newest end first. Its WHERE and ORDER BY are `agents_ended_idx`'s
 * predicate and expression, so it is served by that index whatever the spawn history.
 */
export function endedAgentsQuery(db: Exec) {
  const endedAt = sql`coalesce(${schema.agents.terminatedAt}, ${schema.agents.archivedAt})`;
  return db
    .select()
    .from(schema.agents)
    .where(or(isNotNull(schema.agents.terminatedAt), isNotNull(schema.agents.archivedAt)))
    .orderBy(desc(endedAt))
    .limit(ENDED_LIST_LIMIT + 1);
}

/** S7 §14: a terminated agent's fields; the grace end only while its workspace still exists. */
function terminationFields(r: AgentRow) {
  if (!r.terminatedAt) return {};
  return {
    terminatedAt: r.terminatedAt.toISOString(),
    ...(r.terminatedBy ? { terminatedBy: r.terminatedBy } : {}),
    workspacePinned: r.workspacePinned,
    ...(r.workspaceDeletedAt
      ? { workspaceDeletedAt: r.workspaceDeletedAt.toISOString() }
      : {
          workspaceGraceEndsAt: new Date(
            r.terminatedAt.getTime() + WORKSPACE_GRACE_MS,
          ).toISOString(),
        }),
  };
}

export class AgentService {
  constructor(
    private readonly d: {
      db: Db;
      templates: TemplateIndex;
      workspace: Workspace;
      lock: KeyedMutex;
      runtimes: AgentRuntimes;
      log: RuntimeLog;
      /** The one ContainerManager: a running container counts as a process for the persona-reset gate (spec §11.4). */
      containers?: Pick<ContainerManager, "isRunning">;
      /** Peer events (spec §10.2): the router snapshots the neighborhood and writes the rows. */
      router: Pick<Router, "peerEvents" | "snapshot">;
      /** Reset persona writes its `config_changed` event here when the agent has no loaded runtime. */
      store: Pick<EventStore, "append">;
      bus: Pick<EventBus, "publishAll">;
      /** I2 §7.2: an overlay save writes its event and notice and schedules the restart check here. */
      configChanges: Pick<ConfigChanges, "overlaySaved">;
      /** S9 §10.1: unarchive recomputes every schedule targeting the agent in its transaction (no catch-up). */
      scheduling?: {
        recomputeForTarget(tx: Tx, agentId: string): Promise<void>;
        changed(): void;
      };
    },
  ) {}

  /** The rows are already committed: a failure here is logged and never fails the human's request. */
  private async peerEvents(
    id: string,
    change: PeerChange,
    before: { managerId: string | null; peerIds: string[] },
  ): Promise<void> {
    try {
      await this.d.router.peerEvents(id, change, before);
    } catch (err) {
      this.d.log.error({ err, agent: id }, "Writing peer events failed");
    }
  }

  private snapshot(id: string, tx: Exec = this.d.db) {
    return this.d.router.snapshot(tx, id);
  }

  /**
   * `exclude`: the live agents (neither archived nor terminated), in tree order. `only`: the ended ones (archived or
   * terminated), flat, newest end first, at most `ENDED_LIST_LIMIT` (`more` says whether older ones exist), so the cost
   * stays flat as spawn history grows (S7 §14).
   */
  async list(ended: "exclude" | "only"): Promise<{ agents: AgentSummary[]; more: boolean }> {
    if (ended === "exclude") return { agents: await this.listLive(), more: false };
    const rows = await endedAgentsQuery(this.d.db);
    const more = rows.length > ENDED_LIST_LIMIT;
    const shown = rows.slice(0, ENDED_LIST_LIMIT);
    return { agents: await this.summarize(shown.map((row) => ({ row, depth: 0 }))), more };
  }

  private async listLive(): Promise<AgentSummary[]> {
    const rows = await this.d.db
      .select()
      .from(schema.agents)
      .where(and(isNull(schema.agents.archivedAt), isNull(schema.agents.terminatedAt)));
    const slugOf = await this.slugsOf(rows);
    const order = treeOrder(
      rows.map((r) => ({
        slug: r.slug,
        displayName: r.displayName,
        reportsTo: r.reportsTo ? (slugOf.get(r.reportsTo) ?? null) : null,
      })),
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    return this.summarize(
      order.map(({ slug, depth }) => {
        const row = bySlug.get(slug);
        if (!row) throw new Error("tree order returned an unknown slug");
        return { row, depth };
      }),
      slugOf,
    );
  }

  /** The managers' slugs of `rows`, read for those managers only. */
  private async slugsOf(rows: AgentRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.reportsTo ? [r.reportsTo] : [])))];
    if (ids.length === 0) return new Map();
    const managers = await this.d.db
      .select({ id: schema.agents.id, slug: schema.agents.slug })
      .from(schema.agents)
      .where(inArray(schema.agents.id, ids));
    return new Map(managers.map((m) => [m.id, m.slug]));
  }

  /**
   * The summaries of the shown rows only: their managers, their live reports (S7 §9.2: an ended agent has none to
   * count) and their grants are each read for those rows, never for every agent ever spawned.
   */
  private async summarize(
    shown: { row: AgentRow; depth: number }[],
    managerSlugs?: Map<string, string>,
  ): Promise<AgentSummary[]> {
    const { db } = this.d;
    if (shown.length === 0) return [];
    const rows = shown.map((s) => s.row);
    const slugOf = managerSlugs ?? (await this.slugsOf(rows));
    const liveIds = rows.filter((r) => !r.archivedAt && !r.terminatedAt).map((r) => r.id);
    const reportCount = new Map<string, number>();
    if (liveIds.length > 0)
      for (const r of await db
        .select({ managerId: schema.agents.reportsTo, n: count() })
        .from(schema.agents)
        .where(and(inArray(schema.agents.reportsTo, liveIds), liveAgent))
        .groupBy(schema.agents.reportsTo))
        if (r.managerId) reportCount.set(r.managerId, r.n);
    const openTasks = new Map<string, number>();
    for (const r of await db
      .select({ agentId: schema.tasks.assigneeAgentId, n: count() })
      .from(schema.tasks)
      .where(
        and(
          inArray(
            schema.tasks.assigneeAgentId,
            rows.map((x) => x.id),
          ),
          inArray(schema.tasks.status, ["open", "in_progress"]),
        ),
      )
      .groupBy(schema.tasks.assigneeAgentId))
      if (r.agentId) openTasks.set(r.agentId, r.n);
    // S9: schedules targeting each shown agent that are neither deleted nor done (the strip's link).
    const scheduleCount = new Map<string, number>();
    for (const r of await db
      .select({ agentId: schema.schedules.targetAgentId, n: count() })
      .from(schema.schedules)
      .where(
        and(
          inArray(
            schema.schedules.targetAgentId,
            rows.map((x) => x.id),
          ),
          isNull(schema.schedules.deletedAt),
          sql`not (${schema.schedules.runAt} is not null and ${schema.schedules.nextRunAt} is null)`,
        ),
      )
      .groupBy(schema.schedules.targetAgentId))
      scheduleCount.set(r.agentId, r.n);
    const credName = new Map(
      (
        await db
          .select({ id: schema.credentials.id, name: schema.credentials.name })
          .from(schema.credentials)
      ).map((c) => [c.id, c.name]),
    );
    const grants = await db
      .select({ agentId: schema.agentProjectGrants.agentId, name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(
        inArray(
          schema.agentProjectGrants.agentId,
          rows.map((r) => r.id),
        ),
      );
    const projectsOf = new Map<string, string[]>();
    for (const g of grants)
      projectsOf.set(g.agentId, [...(projectsOf.get(g.agentId) ?? []), g.name]);
    // U2 §15.3: one avatar check per distinct template, run live from disk (never cached across responses).
    const avatarOf = new Map(
      await Promise.all(
        [...new Set(rows.map((r) => r.template))].map(
          async (t) =>
            [
              t,
              nameSchema.safeParse(t).success
                ? (await avatarStat(path.join(this.d.templates.dir, t), this.d.templates.dir))
                    .version
                : null,
            ] as const,
        ),
      ),
    );

    return Promise.all(
      shown.map(async ({ row: r, depth }) => ({
        slug: r.slug,
        displayName: r.displayName,
        description: r.description,
        kind: r.kind as "persistent" | "ephemeral",
        template: r.template,
        runtime: r.runtime,
        reportsTo: r.reportsTo ? (slugOf.get(r.reportsTo) ?? null) : null,
        reports: reportCount.get(r.id) ?? 0,
        openTasks: openTasks.get(r.id) ?? 0,
        scheduleCount: scheduleCount.get(r.id) ?? 0,
        avatarVersion: avatarOf.get(r.template) ?? null,
        color: r.color,
        credential: credName.get(r.credentialId ?? "") ?? null,
        projects: (projectsOf.get(r.id) ?? []).sort(),
        depth,
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        ...terminationFields(r),
        ...(await this.d.runtimes.liveFields(r.id, r)),
      })),
    );
  }

  /** A live agent's summary comes from the live tree (its depth); an ended one's is read alone. */
  async summary(slug: string): Promise<AgentSummary> {
    const [row] = await this.d.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
    if (!row) throw this.notFound(slug);
    const found =
      row.archivedAt || row.terminatedAt
        ? (await this.summarize([{ row, depth: 0 }]))[0]
        : (await this.listLive()).find((a) => a.slug === slug);
    if (!found) throw this.notFound(slug);
    return found;
  }

  /** S7 §9.3: a spawned agent follows its spawner and its template; it is terminated, never edited. */
  private assertPersistent(row: AgentRow) {
    if (row.kind === "ephemeral")
      throw new ApiError(
        409,
        "ephemeral_agent",
        "Spawned agents can't be edited; terminate it instead.",
      );
  }

  /** S7 §5.7: the spawner's row first, `FOR NO KEY UPDATE` (never `FOR UPDATE`), before any child row. */
  private async lockAgent(tx: Tx, id: string) {
    const [r] = await tx
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .for("no key update");
    return r;
  }

  /**
   * S7 §6.3: the one owner of live children's credential and grants. Call inside every transaction that changes a
   * spawner's credential or grants, after the spawner's row is written: it rewrites each live child's `credential_id`
   * to the spawner's and its grants to the spawner's ∩ the child's template `projects`. The projects come from the
   * template's last valid parse in the DB (I2 §6.2), never from disk: a disk read here would start change detection
   * inside this transaction. A template with no valid parse yet grants nothing. Locks the spawner's row, then
   * the children's (§5.7). Returns the changed children's ids; the caller refreshes and restarts them after the commit.
   */
  async syncChildren(tx: Tx, spawnerId: string): Promise<string[]> {
    const spawner = await this.lockAgent(tx, spawnerId);
    if (!spawner) return [];
    const held = await tx
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(eq(schema.agentProjectGrants.agentId, spawnerId));
    const kids = await tx
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.reportsTo, spawnerId),
          eq(schema.agents.kind, "ephemeral"),
          isNull(schema.agents.terminatedAt),
        ),
      )
      .orderBy(asc(schema.agents.id))
      .for("no key update");
    const projectsOf = new Map<string, string[]>();
    for (const name of new Set(kids.map((k) => k.template))) {
      const listed = (await this.d.templates.lastValid(name, tx))?.template.projects;
      projectsOf.set(
        name,
        Array.isArray(listed) ? listed.filter((p): p is string => typeof p === "string") : [],
      );
    }
    const changed: string[] = [];
    for (const k of kids) {
      const projects = projectsOf.get(k.template) ?? [];
      const want = held.filter((p) => projects.includes(p.name));
      const have = (
        await tx
          .select({ id: schema.agentProjectGrants.projectId })
          .from(schema.agentProjectGrants)
          .where(eq(schema.agentProjectGrants.agentId, k.id))
      )
        .map((r) => r.id)
        .sort();
      const sameGrants =
        have.join("\0") ===
        want
          .map((p) => p.id)
          .sort()
          .join("\0");
      if (k.credentialId === spawner.credentialId && sameGrants) continue;
      if (k.credentialId !== spawner.credentialId)
        await tx
          .update(schema.agents)
          .set({ credentialId: spawner.credentialId })
          .where(eq(schema.agents.id, k.id));
      if (!sameGrants) await this.replaceGrants(tx, k.id, want);
      changed.push(k.id);
    }
    return changed;
  }

  private async liveChildren(spawnerId: string): Promise<string[]> {
    const rows = await this.d.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.reportsTo, spawnerId),
          eq(schema.agents.kind, "ephemeral"),
          isNull(schema.agents.terminatedAt),
        ),
      )
      .orderBy(asc(schema.agents.id));
    return rows.map((r) => r.id);
  }

  /** After the commit: the Supervisor reads the credential from the loaded row, so reload, then apply (§6.3). */
  private async applyToChildren(ids: string[]) {
    for (const id of ids) {
      await this.d.runtimes.refresh(id);
      await this.d.runtimes.requestRestart(id);
    }
  }

  private notFound(slug: string) {
    return new ApiError(404, "agent_not_found", `No agent named ${slug}`);
  }

  private async rowBySlug(slug: string): Promise<AgentRow> {
    const [row] = await this.d.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
    if (!row) throw this.notFound(slug);
    return row;
  }

  private async credentialId(name: string): Promise<string> {
    const [c] = await this.d.db
      .select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(eq(schema.credentials.name, name));
    if (!c) throw new FieldError("credential", FIELD_MSG.chooseCredential);
    return c.id;
  }

  private async activeManager(slug: string): Promise<AgentRow> {
    const [m] = await this.d.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.slug, slug),
          eq(schema.agents.kind, "persistent"),
          isNull(schema.agents.archivedAt),
          isNull(schema.agents.terminatedAt),
        ),
      );
    // S7 §9.3: no spawned managers, so reports never hang under an agent that gets terminated.
    if (!m) throw new FieldError("reportsTo", FIELD_MSG.chooseManager);
    return m;
  }

  /** Registered projects by name, in the order given; the first unknown name is a field error. */
  private async projectRows(
    given: string[],
  ): Promise<{ id: string; name: string; hostPath: string }[]> {
    // A repeated name is one grant: the grant table's primary key would reject the duplicate.
    const names = [...new Set(given)];
    const found = names.length
      ? await this.d.db
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            hostPath: schema.projects.hostPath,
          })
          .from(schema.projects)
          .where(inArray(schema.projects.name, names))
      : [];
    const byName = new Map(found.map((p) => [p.name, p]));
    return names.map((n) => {
      const p = byName.get(n);
      if (!p) throw new FieldError("projects", FIELD_MSG.projectRemoved);
      return p;
    });
  }

  async create(b: CreateAgentBody): Promise<AgentSummary> {
    const slugOk = slugSchema.safeParse(b.slug);
    if (!slugOk.success)
      throw new FieldError("slug", slugOk.error.issues[0]?.message ?? FIELD_MSG.slugInvalid);
    return this.d.lock.run(`create:${b.slug}`, () => this.createLocked(b));
  }

  private async createLocked(b: CreateAgentBody): Promise<AgentSummary> {
    const { db, workspace } = this.d;
    // The cheap pre-read before materialising; the claim in the insert transaction is the guarantee (spec §4.1).
    if (await handleKind(db, b.slug)) throw slugTaken();
    const tpl = await this.d.templates.loadValid(b.template);
    const credentialId = await this.credentialId(b.credential);
    const manager = b.reportsTo ? await this.activeManager(b.reportsTo) : null;
    const projects = await this.projectRows(b.projects ?? tpl.config.projects);

    const prep: MaterializeCheck = {
      slug: b.slug,
      displayName: b.displayName,
      description: b.description,
      template: b.template,
      config: tpl.config,
      manager: manager ? { slug: manager.slug, displayName: manager.displayName } : null,
      grants: projects.map((p) => ({ name: p.name, hostPath: p.hostPath })),
    };
    try {
      await workspace.lock.run(b.slug, () => workspace.materialize(b.slug, b.slug, tpl, prep));
    } catch (err) {
      // folder_exists means the folder isn't ours: leave it alone.
      if (!(err instanceof FieldError && err.code === "folder_exists"))
        await workspace.discard(b.slug).catch(() => {});
      throw pluginFailure(err);
    }

    const id = randomUUID();
    try {
      await db.transaction(async (tx) => {
        if (!(await claimHandle(tx, b.slug, "agent"))) throw slugTaken();
        await tx.insert(schema.agents).values({
          id,
          slug: b.slug,
          displayName: b.displayName,
          description: b.description,
          template: b.template,
          // I2 §5.1: the overlay starts empty; the agent runs the live template until someone configures it.
          config: {},
          runtime: tpl.config.runtime,
          reportsTo: manager?.id ?? null,
          credentialId,
        });
        if (projects.length)
          await tx
            .insert(schema.agentProjectGrants)
            .values(projects.map((p) => ({ agentId: id, projectId: p.id })));
      });
    } catch (err) {
      await workspace.discard(b.slug).catch(() => {});
      if (isSlugUnique(err)) throw slugTaken();
      throw err;
    }
    await this.peerEvents(id, { kind: "joined" }, { managerId: null, peerIds: [] });
    return this.summary(b.slug);
  }

  async update(slug: string, b: PatchAgentBody): Promise<AgentSummary> {
    const { db, runtimes } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    const currentGrants = await this.grantNames(row.id);
    const changed = { feeds: false, text: false };
    let moved: { to: string | null } | undefined;
    const set: Partial<typeof schema.agents.$inferInsert> = {};

    if (b.displayName !== undefined && b.displayName !== row.displayName) {
      set.displayName = b.displayName;
      changed.text = true;
    }
    if (b.description !== undefined && b.description !== row.description) {
      set.description = b.description;
      changed.text = true;
    }
    // Identity only: it never feeds the process, so it sets no `changed` flag and never restarts.
    if (b.color !== undefined && b.color !== row.color) set.color = b.color;
    if (b.credential !== undefined) {
      const id = await this.credentialId(b.credential);
      if (id !== row.credentialId) {
        set.credentialId = id;
        changed.feeds = true;
      }
    }
    if (b.reportsTo !== undefined) {
      const manager = b.reportsTo ? await this.activeManager(b.reportsTo) : null;
      if (manager) await this.assertNoCycle(row.id, manager);
      if ((manager?.id ?? null) !== row.reportsTo) {
        set.reportsTo = manager?.id ?? null;
        moved = { to: manager?.slug ?? null };
        changed.feeds = true;
      }
    }
    const before = moved ? await this.snapshot(row.id) : undefined;
    let newGrants: { id: string; name: string }[] | undefined;
    if (b.projects !== undefined) {
      newGrants = await this.projectRows(b.projects);
      const same =
        [...newGrants.map((p) => p.name)].sort().join("\0") ===
        [...currentGrants].sort().join("\0");
      if (!same) changed.feeds = true;
    }

    const children = await db.transaction(async (tx) => {
      await this.lockAgent(tx, row.id);
      if (Object.keys(set).length)
        await tx.update(schema.agents).set(set).where(eq(schema.agents.id, row.id));
      if (newGrants) await this.replaceGrants(tx, row.id, newGrants);
      return this.syncChildren(tx, row.id);
    });

    await runtimes.refresh(row.id);
    await this.applyToChildren(children);
    if (moved && before) await this.peerEvents(row.id, { kind: "moved", to: moved.to }, before);
    if (changed.feeds || changed.text) await runtimes.requestRestart(row.id);
    if (changed.text) {
      const reports = await db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.reportsTo, row.id), liveAgent));
      for (const r of reports) await runtimes.requestRestart(r.id);
    }
    return this.summary(slug);
  }

  private async grantNames(agentId: string): Promise<string[]> {
    const rows = await this.d.db
      .select({ name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(eq(schema.agentProjectGrants.agentId, agentId));
    return rows.map((r) => r.name);
  }

  private async replaceGrants(tx: Tx, agentId: string, projects: { id: string }[]) {
    await tx
      .delete(schema.agentProjectGrants)
      .where(eq(schema.agentProjectGrants.agentId, agentId));
    if (projects.length)
      await tx
        .insert(schema.agentProjectGrants)
        .values(projects.map((p) => ({ agentId, projectId: p.id })));
  }

  /** Walks reportsTo upward from the new manager; reaching the agent itself is a cycle. */
  private async assertNoCycle(id: string, manager: AgentRow) {
    const seen = new Set<string>();
    let cur: AgentRow | undefined = manager;
    while (cur && !seen.has(cur.id)) {
      if (cur.id === id) throw new FieldError("reportsTo", FIELD_MSG.reportsCycle);
      seen.add(cur.id);
      if (!cur.reportsTo) return;
      const [next] = await this.d.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, cur.reportsTo));
      cur = next;
    }
  }

  /** Fails closed: a Docker agent whose container state can't be read (Docker down) is treated as running. */
  private async containerRunning(row: AgentRow): Promise<boolean> {
    if (row.runtime !== "docker") return false;
    if (!this.d.containers) return true;
    try {
      return await this.d.containers.isRunning(row.id, row.slug);
    } catch (err) {
      this.d.log.warn(
        { err, agent: row.slug },
        "couldn't check the container; staging the persona reset",
      );
      return true;
    }
  }

  /**
   * Reset persona (spec §9): the agent's AGENTS.md is replaced with the template's. Written at once when no process
   * (and for Docker no container) is running, else staged for the next start. Archived agents are allowed. The notice
   * line, the event and the restart are scheduled, never awaited: they queue behind the runtime's jobs, and a start
   * waiting in `prepare` holds none of the locks taken here.
   */
  async resetPersona(
    slug: string,
    by: string,
  ): Promise<{ applied: "now" | "on_restart"; backupDir?: string }> {
    const { runtimes, workspace } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    const tpl = await this.d.templates.loadValid(row.template);
    const agentsMd = path.join(tpl.dir, "AGENTS.md");
    // A regular file only: a link would copy its target's bytes into the agent's workdir.
    const templateFileOk = () =>
      lstat(agentsMd).then(
        (s) => s.isFile(),
        () => false,
      );
    const badTemplate = () =>
      new ApiError(
        409,
        "template_invalid",
        `Template ${row.template} needs an AGENTS.md that is a regular file.`,
      );
    if (!(await templateFileOk())) throw badTemplate();
    let r: Awaited<ReturnType<Workspace["resetPersona"]>>;
    try {
      r = await workspace.lock.run(slug, async () => {
        // Decided under the lock every start also takes, so a start can't slip in between. Docker: the container
        // must not be running either (spec §11.4 part 4).
        const rt = await runtimes.get(row.id);
        const canWriteNow = !rt?.hasProcess() && !(await this.containerRunning(row));
        return workspace.resetPersona(slug, agentsMd, { canWriteNow });
      });
    } catch (err) {
      // The template file went away after the check above: the template's fault, not the workdir's.
      if (!(await templateFileOk())) throw badTemplate();
      // Anything else here is the agent's workdir (a link planted in it, AGENTS.md not a file): never the template.
      if (err instanceof WorkspaceError) throw new ApiError(409, "workdir_unusable", err.message);
      throw err;
    }
    // Applied now with nothing differing changes nothing: no notice, no event.
    if (r.changed) this.scheduleResetEffects(row, by, r);
    return { applied: r.applied, ...(r.backupDir ? { backupDir: r.backupDir } : {}) };
  }

  private scheduleResetEffects(
    row: AgentRow,
    by: string,
    r: { applied: "now" | "on_restart"; backupDir?: string },
  ): void {
    const { runtimes, log, store, bus } = this.d;
    const staged = r.applied === "on_restart";
    const what = `AGENTS.md reset from template ${row.template}`;
    // Staged: the old file is saved when the next start applies it. Now: only when one existed to save.
    const saved = staged || r.backupDir ? "; the previous file is saved." : ".";
    const work = (async () => {
      const rt = await runtimes.get(row.id);
      const jobs: Promise<unknown>[] = [];
      // Through the runtime when loaded (published in seq order), else straight to the store, as ConfigChanges does.
      if (rt) jobs.push(rt.appendConfigChanged(by, [what]));
      else await store.append(row.id, null, { type: "config_changed", by, changes: [what] });
      bus.publishAll({ type: "config_changed", agent: row.slug });
      if (!row.archivedAt) {
        jobs.push(runtimes.recordConfigNotice(row.id, [`${what}${saved}`]));
        if (staged)
          jobs.push(runtimes.requestRestart(row.id, { changes: ["persona reset from template"] }));
      }
      for (const j of await Promise.allSettled(jobs))
        if (j.status === "rejected")
          log.error({ err: j.reason, agent: row.slug }, "applying a persona reset failed");
    })();
    work.catch((err) => log.error({ err, agent: row.slug }, "applying a persona reset failed"));
  }

  /** The overlay as stored; one that fails its schema (an agent made before I2) is kept as is for the editor to fix. */
  private overlayOf(row: AgentRow): Record<string, unknown> {
    return row.config as Record<string, unknown>;
  }

  /**
   * The template's current valid doc and folder, or null while it is invalid or missing (an agent's config is then
   * checked against the schema alone, spec §12.1). Never a template's issues: those are fixed in Templates.
   */
  private async templateBase(name: string): Promise<{ doc: ConfigDoc; dir: string } | null> {
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
  private async configIssues(
    row: AgentRow,
    overlay: unknown,
    base: { doc: ConfigDoc; dir: string } | null,
  ) {
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
    return {
      overlay,
      version: overlayVersion(overlay as AgentOverlay),
      template: {
        name: row.template,
        doc: base ? this.forEditing(base.doc) : null,
        valid: base !== null,
      },
      merged: base && parsed.success ? this.forEditing(mergeConfig(base.doc, parsed.data)) : null,
      issues,
    };
  }

  /**
   * I2 §12.1 `PUT /api/agents/:slug/config`. Validation (disk reads included) runs before the transaction, which only
   * locks the row, compares the JS-computed versions and writes: Postgres' `jsonb::text` doesn't sort keys the way the
   * canonical form does, so the version is never computed in SQL. The restart check is scheduled, never awaited
   * (spec §7.2). Issues carry paths and constant messages, never a value.
   */
  async putConfig(
    slug: string,
    b: PutAgentConfigBody,
    by: string,
  ): Promise<PutAgentConfigResponse> {
    const { db } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    const parsed = agentOverlaySchema.safeParse(b.overlay);
    const base = await this.templateBase(row.template);
    const issues = await this.configIssues(row, b.overlay, base);
    if (!parsed.success || issues.some((i) => i.severity === "error"))
      throw new ApiError(400, "invalid_config", "The configuration has errors.", { issues });
    const overlay = parsed.data;

    const before = await db.transaction(async (tx) => {
      const locked = await this.lockAgent(tx, row.id);
      if (!locked) throw this.notFound(slug);
      const current = this.overlayOf(locked);
      if (overlayVersion(current as AgentOverlay) !== b.baseVersion)
        throw new ApiError(409, "config_changed", "Changed since you opened it.");
      await tx.update(schema.agents).set({ config: overlay }).where(eq(schema.agents.id, row.id));
      return current;
    });

    let applied: { changes: string[]; restartChecked: boolean } = {
      changes: [],
      restartChecked: false,
    };
    // A broken template has no effective config to diff or restart into; the next start reads everything fresh.
    if (base) {
      const was = agentOverlaySchema.safeParse(before);
      applied = await this.d.configChanges.overlaySaved(
        { ...row, config: overlay },
        by,
        mergeConfig(base.doc, was.success ? was.data : {}),
        mergeConfig(base.doc, overlay),
      );
    }
    return {
      ...this.configView({ ...row, config: overlay }, overlay, base, issues),
      ...applied,
      checked: base ? "full" : "schema",
    };
  }

  /** I2 §12.3: the model the agent runs with and where it comes from, read from the rows (no disk, no scan). */
  async modelOf(slug: string): Promise<AgentModel> {
    const row = await this.rowBySlug(slug);
    const own = agentOverlaySchema.safeParse(this.overlayOf(row));
    const mine = own.success ? own.data.template?.model : undefined;
    if (mine) return { value: mine, source: "agent" };
    const doc = await this.d.templates.lastValid(row.template);
    const theirs = doc?.template.model;
    if (typeof theirs === "string" && theirs) return { value: theirs, source: "template" };
    return { value: null, source: "default" };
  }

  async archive(slug: string): Promise<AgentSummary> {
    const { db, runtimes } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    if (row.archivedAt) return this.summary(slug);
    // S7 §5.7: the row lock first (`FOR NO KEY UPDATE`, never `FOR UPDATE`), then the live reports in the same
    // transaction, so a spawn committing in between can't leave an archived spawner a live child.
    const before = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ archivedAt: schema.agents.archivedAt })
        .from(schema.agents)
        .where(eq(schema.agents.id, row.id))
        .for("no key update");
      // A concurrent archive committed while this one waited on the lock: it wrote the peer events.
      if (locked?.archivedAt) return undefined;
      const live = await tx
        .select({ slug: schema.agents.slug, kind: schema.agents.kind })
        .from(schema.agents)
        .where(and(eq(schema.agents.reportsTo, row.id), liveAgent));
      const spawned = live
        .filter((r) => r.kind === "ephemeral")
        .map((r) => r.slug)
        .sort();
      if (spawned.length)
        throw new ApiError(409, "has_reports", spawnedMessage(row.slug, spawned), {
          reports: spawned,
        });
      const reports = live.map((r) => r.slug).sort();
      if (reports.length)
        throw new ApiError(409, "has_reports", reportsMessage(reports), { reports });
      const snap = await this.snapshot(row.id, tx);
      await tx
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, row.id));
      return snap;
    });
    if (!before) return this.summary(slug);
    const rt = await runtimes.get(row.id);
    rt?.markArchived();
    try {
      await rt?.stop({ graceMs: 3000, termWaitMs: 10_000 });
    } catch (err) {
      this.d.log.error({ err, slug }, "Stopping an archived agent failed");
    }
    await runtimes.refresh(row.id);
    await this.peerEvents(row.id, { kind: "left", reason: "archived" }, before);
    return this.summary(slug);
  }

  async unarchive(slug: string): Promise<AgentSummary> {
    const { db, runtimes } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    if (!row.archivedAt) return this.summary(slug);
    // S9 §10.1: the agent row `FOR NO KEY UPDATE` first, then its schedules (agents before schedules). The manager
    // check is inside the lock too, and a concurrent unarchive that lost the race changes nothing and emits nothing.
    const changed = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ archivedAt: schema.agents.archivedAt, reportsTo: schema.agents.reportsTo })
        .from(schema.agents)
        .where(eq(schema.agents.id, row.id))
        .for("no key update");
      if (!locked?.archivedAt) return false;
      if (locked.reportsTo) {
        const [m] = await tx
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, locked.reportsTo));
        if (m?.archivedAt)
          throw new ApiError(
            409,
            "manager_archived",
            `Its manager @${m.slug} is archived. Change its manager first.`,
          );
      }
      await tx.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, row.id));
      await this.d.scheduling?.recomputeForTarget(tx, row.id);
      return true;
    });
    if (!changed) return this.summary(slug);
    await runtimes.refresh(row.id);
    // After the refresh: a firing in the millisecond before it reaches a runtime that still thinks the agent is
    // archived and is rejected (accepted, spec §10.1).
    this.d.scheduling?.changed();
    await this.peerEvents(row.id, { kind: "joined" }, { managerId: null, peerIds: [] });
    return this.summary(slug);
  }
}
