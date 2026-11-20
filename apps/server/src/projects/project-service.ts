import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@open-factory/db";
import type { ProjectSummary } from "@open-factory/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { inUseViolation, pgCode, tags } from "../db-errors.ts";
import { ApiError, FieldError } from "../errors.ts";
import type { TemplateIndex } from "../templates/template-index.ts";

type ProjectRow = typeof schema.projects.$inferSelect;
type Holder = { id: string; slug: string; spawnedBy?: string };
interface Grants {
  active: Holder[];
  archived: Holder[];
}

export class ProjectService {
  constructor(
    private readonly d: {
      db: Db;
      runtimes: AgentRuntimes;
      templates: TemplateIndex;
      log?: { warn: (obj: object, msg: string) => void };
    },
  ) {}

  private async grants(projectId: string): Promise<Grants> {
    const rows = await this.d.db
      .select({
        id: schema.agents.id,
        slug: schema.agents.slug,
        archivedAt: schema.agents.archivedAt,
        kind: schema.agents.kind,
        reportsTo: schema.agents.reportsTo,
      })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentProjectGrants.agentId))
      .where(
        and(
          eq(schema.agentProjectGrants.projectId, projectId),
          // A terminated agent's grants are gone anyway; it never blocks a delete.
          isNull(schema.agents.terminatedAt),
        ),
      );
    const spawnerIds = [
      ...new Set(rows.flatMap((r) => (r.kind === "ephemeral" && r.reportsTo ? [r.reportsTo] : []))),
    ];
    const spawners = new Map(
      spawnerIds.length
        ? (
            await this.d.db
              .select({ id: schema.agents.id, slug: schema.agents.slug })
              .from(schema.agents)
              .where(inArray(schema.agents.id, spawnerIds))
          ).map((a) => [a.id, a.slug])
        : [],
    );
    const holders: (Holder & { archivedAt: Date | null })[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      archivedAt: r.archivedAt,
      ...(r.kind === "ephemeral" && r.reportsTo && spawners.get(r.reportsTo)
        ? { spawnedBy: spawners.get(r.reportsTo) }
        : {}),
    }));
    const bySlug = (a: Holder, b: Holder) => a.slug.localeCompare(b.slug);
    return {
      active: holders.filter((r) => !r.archivedAt).sort(bySlug),
      archived: holders.filter((r) => r.archivedAt).sort(bySlug),
    };
  }

  private async templatesListing(): Promise<{ name: string; projects: string[] }[]> {
    return (await this.d.templates.scan()).map((r) => ({
      name: r.name,
      projects: r.config?.projects ?? [],
    }));
  }

  private async summarize(
    row: ProjectRow,
    tpls?: { name: string; projects: string[] }[],
  ): Promise<ProjectSummary> {
    const g = await this.grants(row.id);
    const all = tpls ?? (await this.templatesListing());
    return {
      name: row.name,
      hostPath: row.hostPath,
      grantedTo: g.active.map((a) => a.slug),
      archivedGrantedTo: g.archived.map((a) => a.slug),
      templates: all
        .filter((t) => t.projects.includes(row.name))
        .map((t) => t.name)
        .sort(),
    };
  }

  private async rowByName(name: string) {
    const [row] = await this.d.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.name, name));
    if (!row) throw new ApiError(404, "project_not_found", `No project named ${name}.`);
    return row;
  }

  /** The realpath of an existing absolute folder, or a hostPath field error. */
  private async resolveFolder(hostPath: string): Promise<string> {
    if (!path.isAbsolute(hostPath)) throw new FieldError("hostPath", "Enter an absolute path.");
    const missing = () => new FieldError("hostPath", `No folder at ${hostPath}.`);
    try {
      const real = await realpath(hostPath);
      if (!(await stat(real)).isDirectory()) throw missing();
      return real;
    } catch (err) {
      throw err instanceof FieldError ? err : missing();
    }
  }

  private async assertPathFree(real: string, exceptId?: string) {
    const [other] = await this.d.db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.hostPath, real));
    if (other && other.id !== exceptId)
      throw new FieldError("hostPath", `Project ${other.name} already uses this folder.`);
  }

  async list(): Promise<ProjectSummary[]> {
    const rows = await this.d.db.select().from(schema.projects);
    const tpls = await this.templatesListing();
    return Promise.all(
      rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.summarize(r, tpls)),
    );
  }

  async create(b: { name: string; hostPath: string }): Promise<ProjectSummary> {
    const exists = () =>
      new ApiError(409, "project_exists", `A project named ${b.name} already exists.`);
    const [taken] = await this.d.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.name, b.name));
    if (taken) throw exists();
    const real = await this.resolveFolder(b.hostPath);
    await this.assertPathFree(real);
    try {
      const [row] = await this.d.db
        .insert(schema.projects)
        .values({ id: randomUUID(), name: b.name, hostPath: real })
        .returning();
      if (!row) throw new Error("project insert returned no row");
      return this.summarize(row);
    } catch (err) {
      if (!pgCode(err, "23505")) throw err;
      // Lost a race: report whichever unique value collided.
      const [byName] = await this.d.db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.name, b.name));
      if (byName) throw exists();
      await this.assertPathFree(real);
      throw err;
    }
  }

  async update(name: string, hostPath: string): Promise<ProjectSummary> {
    const row = await this.rowByName(name);
    const real = await this.resolveFolder(hostPath);
    if (real === row.hostPath) return this.summarize(row);
    await this.assertPathFree(real, row.id);
    let updated: ProjectRow | undefined;
    try {
      [updated] = await this.d.db
        .update(schema.projects)
        .set({ hostPath: real, updatedAt: new Date() })
        .where(eq(schema.projects.id, row.id))
        .returning();
    } catch (err) {
      if (pgCode(err, "23505")) await this.assertPathFree(real, row.id);
      throw err;
    }
    if (!updated) throw new ApiError(404, "project_not_found", `No project named ${name}.`);
    // The symlink and additionalDirectories change at the next start.
    const holders = (await this.grants(row.id)).active;
    const results = await Promise.allSettled(
      holders.map((a) => this.d.runtimes.requestRestart(a.id)),
    );
    results.forEach((r, i) => {
      if (r.status === "rejected")
        this.d.log?.warn({ slug: holders[i]?.slug }, "restart after project change failed");
    });
    return this.summarize(updated);
  }

  private async inUse(id: string, name: string) {
    const g = await this.grants(id);
    if (!g.active.length && !g.archived.length) return undefined;
    const templates = (await this.templatesListing())
      .filter((t) => t.projects.includes(name))
      .map((t) => t.name)
      .sort();
    const grantedTo = g.active.map((a) => a.slug);
    const archivedGrantedTo = g.archived.map((a) => a.slug);
    const direct = g.active.filter((a) => !a.spawnedBy).map((a) => a.slug);
    const message = [
      direct.length ? `Granted to ${tags(direct)}. Remove the grant first.` : "",
      ...g.active
        .filter((a) => a.spawnedBy)
        .map(
          (a) =>
            `Granted to @${a.slug} (spawned by @${a.spawnedBy}); change @${a.spawnedBy}'s grants or terminate it first.`,
        ),
      archivedGrantedTo.length
        ? `Archived agents ${tags(archivedGrantedTo)} still hold a grant.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return new ApiError(409, "project_in_use", message, {
      grantedTo,
      archivedGrantedTo,
      templates,
    });
  }

  async remove(name: string): Promise<void> {
    const row = await this.rowByName(name);
    const busy = await this.inUse(row.id, row.name);
    if (busy) throw busy;
    try {
      await this.d.db.delete(schema.projects).where(eq(schema.projects.id, row.id));
    } catch (err) {
      // A grant appeared after the check: the FK restricts the delete.
      if (inUseViolation(err)) throw (await this.inUse(row.id, row.name)) ?? err;
      throw err;
    }
  }
}
