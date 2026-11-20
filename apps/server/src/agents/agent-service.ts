import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type AgentSummary,
  type CreateAgentBody,
  type PatchAgentBody,
  slugSchema,
  treeOrder,
} from "@open-factory/shared";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ApiError, FieldError } from "../errors.ts";
import { liveAgent } from "../messaging/neighborhood.ts";
import { isNameTaken } from "../messaging/principals.ts";
import type { PeerChange, Router } from "../messaging/router.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import { PluginInstallError } from "../workspace/plugins.ts";
import type { MaterializeCheck, Workspace } from "../workspace/workspace.ts";
import type { RuntimeLog } from "./agent-runtime.ts";
import type { Exec, Tx } from "./event-store.ts";
import type { AgentRuntimes } from "./runtimes.ts";

const slugTaken = () => new FieldError("slug", "That slug is taken.", "slug_taken");

function isSlugUnique(e: unknown): boolean {
  for (let x = e as { code?: string; constraint_name?: string; cause?: unknown } | undefined; x; ) {
    if (x.code === "23505" && (x.constraint_name ?? "").includes("slug")) return true;
    x = x.cause as typeof x;
  }
  return false;
}

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

export class AgentService {
  constructor(
    private readonly d: {
      db: Db;
      templates: TemplateIndex;
      workspace: Workspace;
      lock: KeyedMutex;
      runtimes: AgentRuntimes;
      log: RuntimeLog;
      /** The one ContainerManager: a running container counts as a process for the re-sync gate (spec §11.4). */
      containers?: Pick<ContainerManager, "isRunning">;
      /** Peer events (spec §10.2): the router snapshots the neighborhood and writes the rows. */
      router: Pick<Router, "peerEvents" | "snapshot">;
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

  async list(ended: "exclude" | "include" | "only"): Promise<AgentSummary[]> {
    const { db } = this.d;
    const rows = await db
      .select()
      .from(schema.agents)
      .where(
        ended === "exclude"
          ? isNull(schema.agents.archivedAt)
          : ended === "only"
            ? isNotNull(schema.agents.archivedAt)
            : undefined,
      );
    const allAgents = await db
      .select({
        id: schema.agents.id,
        slug: schema.agents.slug,
        reportsTo: schema.agents.reportsTo,
        archivedAt: schema.agents.archivedAt,
        terminatedAt: schema.agents.terminatedAt,
      })
      .from(schema.agents);
    const slugById = new Map(allAgents.map((r) => [r.id, r.slug]));
    const reportCount = new Map<string, number>();
    for (const a of allAgents)
      if (a.reportsTo && !a.archivedAt && !a.terminatedAt)
        reportCount.set(a.reportsTo, (reportCount.get(a.reportsTo) ?? 0) + 1);
    const credName = new Map(
      (await db.select().from(schema.credentials)).map((c) => [c.id, c.name]),
    );
    const grants = await db
      .select({ agentId: schema.agentProjectGrants.agentId, name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId));
    const projectsOf = new Map<string, string[]>();
    for (const g of grants)
      projectsOf.set(g.agentId, [...(projectsOf.get(g.agentId) ?? []), g.name]);

    const info = rows.map((r) => ({
      row: r,
      reportsTo: r.reportsTo ? (slugById.get(r.reportsTo) ?? null) : null,
    }));
    const order = treeOrder(
      info.map((i) => ({
        slug: i.row.slug,
        displayName: i.row.displayName,
        reportsTo: i.reportsTo,
      })),
    );
    const bySlug = new Map(info.map((i) => [i.row.slug, i]));
    return Promise.all(
      order.map(async ({ slug, depth }) => {
        const i = bySlug.get(slug);
        if (!i) throw new Error("tree order returned an unknown slug");
        const r = i.row;
        return {
          slug: r.slug,
          displayName: r.displayName,
          description: r.description,
          kind: r.kind as "persistent" | "ephemeral",
          template: r.template,
          runtime: r.runtime,
          reportsTo: i.reportsTo,
          reports: reportCount.get(r.id) ?? 0,
          credential: credName.get(r.credentialId ?? "") ?? null,
          projects: (projectsOf.get(r.id) ?? []).sort(),
          grantsOverridden: r.grantsOverridden,
          depth,
          archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
          ...(await this.d.runtimes.liveFields(r.id, r)),
        };
      }),
    );
  }

  async summary(slug: string): Promise<AgentSummary> {
    const found = (await this.list("include")).find((a) => a.slug === slug);
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
   * to the spawner's and its grants to the spawner's ∩ the child's template `projects`. Locks the spawner's row, then
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
    const changed: string[] = [];
    for (const k of kids) {
      const want = held.filter((p) => k.config.projects.includes(p.name));
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
    if (!c) throw new FieldError("credential", "Choose a credential.");
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
    if (!m) throw new FieldError("reportsTo", "Choose an active agent.");
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
      if (!p) throw new FieldError("projects", `Project ${n} isn't registered.`);
      return p;
    });
  }

  async create(b: CreateAgentBody): Promise<AgentSummary> {
    const slugOk = slugSchema.safeParse(b.slug);
    if (!slugOk.success)
      throw new FieldError("slug", slugOk.error.issues[0]?.message ?? "Invalid slug.");
    return this.d.lock.run(`create:${b.slug}`, () => this.createLocked(b));
  }

  private async createLocked(b: CreateAgentBody): Promise<AgentSummary> {
    const { db, workspace } = this.d;
    // One rule (spec §7.1). A simultaneous sign-up and agent create with the same name is an accepted race; sends then fail with 'matches both'.
    const taken = await isNameTaken(db, b.slug);
    if (taken === "agent" || taken === "user") throw slugTaken();
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
        await tx.insert(schema.agents).values({
          id,
          slug: b.slug,
          displayName: b.displayName,
          description: b.description,
          template: b.template,
          config: tpl.config,
          runtime: tpl.config.runtime,
          reportsTo: manager?.id ?? null,
          credentialId,
          grantsOverridden: b.projects !== undefined,
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
    if (b.credential !== undefined) {
      const id = await this.credentialId(b.credential);
      if (id !== row.credentialId) {
        set.credentialId = id;
        changed.feeds = true;
      }
    }
    if (b.reportsTo !== undefined) {
      const manager = b.reportsTo ? await this.activeManager(b.reportsTo) : null;
      if (manager) await this.assertNoCycle(slug, row.id, manager);
      if ((manager?.id ?? null) !== row.reportsTo) {
        set.reportsTo = manager?.id ?? null;
        moved = { to: manager?.slug ?? null };
        changed.feeds = true;
      }
    }
    const before = moved ? await this.snapshot(row.id) : undefined;
    let newGrants: { id: string; name: string }[] | undefined;
    if (b.projects !== undefined) {
      const names = b.projects === null ? row.config.projects : b.projects;
      newGrants = await this.projectRows(names);
      set.grantsOverridden = b.projects !== null;
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
  private async assertNoCycle(slug: string, id: string, manager: AgentRow) {
    const seen = new Set<string>();
    let cur: AgentRow | undefined = manager;
    while (cur && !seen.has(cur.id)) {
      if (cur.id === id)
        throw new FieldError(
          "reportsTo",
          `That would make @${slug} report to itself through @${manager.slug}.`,
        );
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
        "couldn't check the container; staging the re-sync",
      );
      return true;
    }
  }

  async resync(
    slug: string,
  ): Promise<{ agent: AgentSummary; backupDir?: string; applied: "now" | "on_restart" }> {
    const { db, runtimes, workspace } = this.d;
    const row = await this.rowBySlug(slug);
    this.assertPersistent(row);
    if (row.archivedAt)
      throw new ApiError(409, "agent_archived", `@${slug} is archived. Restore it first.`);
    const tpl = await this.d.templates.loadValid(row.template);
    let backupDir: string | undefined;
    let applied: "now" | "on_restart" = "now";
    let children: string[] = [];
    try {
      await workspace.lock.run(slug, async () => {
        // Checked before any disk change, so a stale template project leaves everything as it was.
        const projects = row.grantsOverridden
          ? undefined
          : await this.templateProjects(tpl.config.projects, row.template);
        // Decided under the lock every start also takes, so a start can't slip in between. Docker: the container
        // must not be running either (spec §11.4 part 4).
        const rt = await runtimes.get(row.id);
        const canWriteNow = !rt?.hasProcess() && !(await this.containerRunning(row));
        const r = await workspace.resync(slug, tpl, { canWriteNow });
        backupDir = r.backupDir;
        applied = r.applied;
        children = await db.transaction(async (tx) => {
          await this.lockAgent(tx, row.id);
          await tx
            .update(schema.agents)
            .set({ config: tpl.config, runtime: tpl.config.runtime })
            .where(eq(schema.agents.id, row.id));
          if (projects) await this.replaceGrants(tx, row.id, projects);
          return this.syncChildren(tx, row.id);
        });
      });
    } catch (err) {
      throw pluginFailure(err);
    }
    await runtimes.refresh(row.id);
    await runtimes.requestRestart(row.id);
    await this.applyToChildren(children);
    return { agent: await this.summary(slug), applied, ...(backupDir ? { backupDir } : {}) };
  }

  private async templateProjects(names: string[], template: string) {
    try {
      return await this.projectRows(names);
    } catch (err) {
      if (err instanceof FieldError)
        throw new ApiError(409, "template_invalid", `Template ${template}: ${err.message}`);
      throw err;
    }
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
    if (row.reportsTo) {
      const [m] = await db.select().from(schema.agents).where(eq(schema.agents.id, row.reportsTo));
      if (m?.archivedAt)
        throw new ApiError(
          409,
          "manager_archived",
          `Its manager @${m.slug} is archived. Change its manager first.`,
        );
    }
    await db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, row.id));
    await runtimes.refresh(row.id);
    await this.peerEvents(row.id, { kind: "joined" }, { managerId: null, peerIds: [] });
    return this.summary(slug);
  }
}
