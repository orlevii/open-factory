import { type Db, schema } from "@open-factory/db";
import { parseTaskKey, type TaskStatus, taskKey } from "@open-factory/shared";
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { blockedBy, isBlocked } from "./blocked.ts";
import { TaskError } from "./errors.ts";
import { escapeLike } from "./like.ts";
import type { Actor } from "./permission.ts";
import type { TaskStore } from "./task-store.ts";

const { tasks, agents, users, taskComments, taskEvents } = schema;

export type AgentRef = { slug: string; displayName: string; ended?: "archived" | "terminated" };
export type PrincipalRef = { kind: "agent"; slug: string } | { kind: "user"; handle: string };
export type TaskSummary = {
  key: string;
  title: string;
  status: TaskStatus;
  assignee: AgentRef | null;
  blockedBy: string[];
  createdBy: PrincipalRef;
  updatedAt: Date;
};
export type ListFilter = {
  /** Default `["open", "in_progress"]`; "all" for every status. */
  status?: TaskStatus[] | "all";
  /** An agent slug, or "me" (an agent caller). */
  assignee?: string;
  unassigned?: boolean;
  /** An agent slug, a human `@handle`, or "me" (the caller). */
  createdBy?: string;
  /** `T-41` style keys: just those tasks. */
  keys?: string[];
  /** A case-insensitive title substring; `%` and `_` match themselves. */
  q?: string;
  before?: string;
  limit?: number;
};

const ended = (a: { archivedAt: Date | null; terminatedAt: Date | null }) =>
  a.terminatedAt ? ("terminated" as const) : a.archivedAt ? ("archived" as const) : undefined;

/** Only a cursor this module minted reaches Postgres (UTC ISO with milliseconds, then the id). */
function parseCursor(raw: string): { at: Date; id: string } {
  const [at, id] = raw.split("|");
  const d = at && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ? new Date(at) : undefined;
  if (!d || Number.isNaN(d.getTime()) || !id || id.length > 64)
    throw new TaskError("invalid_cursor", "That page link is no longer valid.", 400, "before");
  return { at: d, id };
}

export class TaskReads {
  constructor(private readonly d: { db: Db; tasks: TaskStore }) {}

  /** A page of tasks, newest updated first (`updated_at desc, id`). */
  async list(
    actor: Actor,
    f: ListFilter,
  ): Promise<{ items: TaskSummary[]; nextCursor: string | null }> {
    const db = this.d.db;
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const aa = alias(agents, "aa");
    const ca = alias(agents, "ca");
    const where: (SQL | undefined)[] = [];
    if (f.keys) {
      const ns = f.keys.map((k) => parseTaskKey(k)).filter((n): n is number => n !== null);
      if (!ns.length) return { items: [], nextCursor: null };
      where.push(inArray(tasks.number, ns));
    } else {
      const status = f.status ?? (["open", "in_progress"] as TaskStatus[]);
      if (status !== "all") where.push(inArray(tasks.status, status));
    }
    if (f.q) where.push(sql`${tasks.title} ilike ${`%${escapeLike(f.q)}%`} escape '\\'`);
    if (f.unassigned) where.push(isNull(tasks.assigneeAgentId));
    else if (f.assignee)
      where.push(eq(tasks.assigneeAgentId, await this.agentId(actor, f.assignee)));
    if (f.createdBy) {
      const who = await this.creator(actor, f.createdBy);
      where.push(
        "agentId" in who
          ? eq(tasks.createdByAgentId, who.agentId)
          : eq(tasks.createdByUserId, who.userId),
      );
    }
    if (f.before) {
      const c = parseCursor(f.before);
      where.push(
        or(lt(tasks.updatedAt, c.at), and(eq(tasks.updatedAt, c.at), sql`${tasks.id} > ${c.id}`)),
      );
    }
    const rows = await db
      .select({
        t: tasks,
        aSlug: aa.slug,
        aName: aa.displayName,
        aArchived: aa.archivedAt,
        aTerminated: aa.terminatedAt,
        cSlug: ca.slug,
        cHandle: users.handle,
      })
      .from(tasks)
      .leftJoin(aa, eq(aa.id, tasks.assigneeAgentId))
      .leftJoin(ca, eq(ca.id, tasks.createdByAgentId))
      .leftJoin(users, eq(users.id, tasks.createdByUserId))
      .where(and(...where))
      .orderBy(desc(tasks.updatedAt), asc(tasks.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const deps = await this.d.tasks.depStatuses(
      db,
      page.map((r) => r.t.id),
    );
    const items = page.map((r) => {
      const status = r.t.status as TaskStatus;
      const e = r.aSlug
        ? ended({ archivedAt: r.aArchived, terminatedAt: r.aTerminated })
        : undefined;
      return {
        key: taskKey(r.t.number),
        title: r.t.title,
        status,
        assignee: r.aSlug
          ? { slug: r.aSlug, displayName: r.aName as string, ...(e ? { ended: e } : {}) }
          : null,
        blockedBy: blockedBy(
          status,
          (deps.get(r.t.id) ?? []).map((x) => ({ key: taskKey(x.number), status: x.status })),
        ),
        createdBy: (r.cSlug
          ? { kind: "agent", slug: r.cSlug }
          : { kind: "user", handle: r.cHandle as string }) as PrincipalRef,
        updatedAt: r.t.updatedAt,
      } satisfies TaskSummary;
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last ? `${last.t.updatedAt.toISOString()}|${last.t.id}` : null,
    };
  }

  /**
   * One task with its dependencies, dependents, links and comments. `comments`: "all", or the newest `limit` before
   * a comment id (oldest first, with how many came earlier). `events`: the history, for the human detail page.
   */
  async detail(
    key: string,
    o: { comments: "all" | { before?: string; limit: number }; events?: boolean },
  ) {
    const db = this.d.db;
    const n = parseTaskKey(key);
    const t = n === null ? undefined : await this.d.tasks.byNumber(db, n);
    if (!t) throw new TaskError("task_not_found", `No task ${key}.`, 404);
    const aa = alias(agents, "aa");
    const [a] = t.assigneeAgentId
      ? await db.select().from(aa).where(eq(aa.id, t.assigneeAgentId))
      : [];
    const assignee: AgentRef | null = a
      ? {
          slug: a.slug,
          displayName: a.displayName,
          ...(ended(a) ? { ended: ended(a) as "archived" | "terminated" } : {}),
        }
      : null;
    const [creatorAgent] = t.createdByAgentId
      ? await db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, t.createdByAgentId))
      : [];
    const [creatorUser] = t.createdByUserId
      ? await db.select({ handle: users.handle }).from(users).where(eq(users.id, t.createdByUserId))
      : [];
    const createdBy: PrincipalRef = creatorAgent
      ? { kind: "agent", slug: creatorAgent.slug }
      : { kind: "user", handle: creatorUser?.handle as string };

    const deps = await this.d.tasks.dependencies(db, t.id);
    const dependents = await this.d.tasks.dependents(db, t.id);
    const relatedIds = [t.id, ...deps.map((x) => x.id), ...dependents.map((x) => x.id)];
    const stat = await this.d.tasks.depStatuses(db, relatedIds);
    const blockedOf = (id: string, status: TaskStatus) =>
      isBlocked(
        status,
        (stat.get(id) ?? []).map((x) => x.status),
      );
    const status = t.status as TaskStatus;
    const dependentAssignees = dependents.length
      ? await db
          .select({ id: agents.id, slug: agents.slug })
          .from(agents)
          .where(
            inArray(
              agents.id,
              dependents.flatMap((x) => (x.assigneeAgentId ? [x.assigneeAgentId] : [])),
            ),
          )
      : [];
    const links = (await this.d.tasks.links(db, t.id)).map((l) => ({
      kind: l.kind,
      ...(l.target ? { target: l.target } : {}),
      ...(l.agentSlug
        ? {
            agent: {
              slug: l.agentSlug,
              displayName: l.agentDisplayName as string,
              ...(ended({ archivedAt: l.agentArchivedAt, terminatedAt: l.agentTerminatedAt })
                ? {
                    ended: ended({
                      archivedAt: l.agentArchivedAt,
                      terminatedAt: l.agentTerminatedAt,
                    }) as "archived" | "terminated",
                  }
                : {}),
            },
          }
        : {}),
      ...(l.title ? { title: l.title } : {}),
    }));

    // Comments.
    const ca = alias(agents, "ca");
    const cols = {
      id: taskComments.id,
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      agentSlug: ca.slug,
      handle: users.handle,
    };
    const commentRows = async (extra?: SQL, newestFirstLimit?: number) => {
      const q = db
        .select(cols)
        .from(taskComments)
        .leftJoin(ca, eq(ca.id, taskComments.authorAgentId))
        .leftJoin(users, eq(users.id, taskComments.authorUserId))
        .where(and(eq(taskComments.taskId, t.id), extra))
        .orderBy(
          ...(newestFirstLimit
            ? [desc(taskComments.createdAt), desc(taskComments.id)]
            : [asc(taskComments.createdAt), asc(taskComments.id)]),
        );
      return newestFirstLimit ? (await q.limit(newestFirstLimit)).reverse() : q;
    };
    let rows: Awaited<ReturnType<typeof commentRows>>;
    let earlier = 0;
    if (o.comments === "all") rows = await commentRows();
    else {
      let extra: SQL | undefined;
      if (o.comments.before) {
        const [c] = await db
          .select({ at: taskComments.createdAt, id: taskComments.id })
          .from(taskComments)
          .where(and(eq(taskComments.id, o.comments.before), eq(taskComments.taskId, t.id)));
        if (!c)
          throw new TaskError(
            "no_comment",
            `No comment ${o.comments.before} on ${taskKey(t.number)}.`,
            400,
          );
        extra = sql`(${taskComments.createdAt}, ${taskComments.id}) < (${c.at.toISOString()}::timestamptz, ${c.id})`;
      }
      rows = await commentRows(extra, o.comments.limit);
      const first = rows[0];
      if (first) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(taskComments)
          .where(
            and(
              eq(taskComments.taskId, t.id),
              sql`(${taskComments.createdAt}, ${taskComments.id}) < (${first.createdAt.toISOString()}::timestamptz, ${first.id})`,
            ),
          );
        earlier = count;
      }
    }
    const comments = rows.map((c) => ({
      id: c.id,
      author: (c.agentSlug
        ? { kind: "agent", slug: c.agentSlug }
        : { kind: "user", handle: c.handle as string }) as PrincipalRef,
      body: c.body,
      createdAt: c.createdAt,
    }));

    const events = o.events ? await this.events(t.id) : undefined;
    return {
      id: t.id,
      key: taskKey(t.number),
      title: t.title,
      body: t.body,
      status,
      assignee,
      createdBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      blockedBy: blockedBy(
        status,
        deps.map((x) => ({ key: taskKey(x.number), status: x.status })),
      ),
      dependsOn: deps.map((x) => ({
        key: taskKey(x.number),
        title: x.title,
        status: x.status,
        blocked: blockedOf(x.id, x.status),
      })),
      blocks: dependents.map((x) => ({
        key: taskKey(x.number),
        title: x.title,
        status: x.status,
        blocked: blockedOf(x.id, x.status),
        assignee: dependentAssignees.find((g) => g.id === x.assigneeAgentId)?.slug ?? null,
      })),
      links,
      comments,
      earlierComments: earlier,
      ...(events ? { events } : {}),
    };
  }

  /** The history, oldest first; assignee values are current slugs, `body` has none (spec §6.5). */
  private async events(taskId: string) {
    const db = this.d.db;
    const ea = alias(agents, "ea");
    const rows = await db
      .select({
        id: taskEvents.id,
        type: taskEvents.type,
        from: taskEvents.fromValue,
        to: taskEvents.toValue,
        at: taskEvents.at,
        agentSlug: ea.slug,
        handle: users.handle,
      })
      .from(taskEvents)
      .leftJoin(ea, eq(ea.id, taskEvents.actorAgentId))
      .leftJoin(users, eq(users.id, taskEvents.actorUserId))
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.at), asc(taskEvents.id));
    const ids = new Set<string>();
    const collect = (v: unknown) => {
      if (typeof v === "string") ids.add(v);
    };
    for (const r of rows)
      if (r.type === "assignee") {
        collect(r.from);
        collect(r.to);
      } else if (r.type === "links")
        for (const side of [r.from, r.to])
          for (const l of (side as { agentId?: string }[] | null) ?? [])
            if (l.agentId) ids.add(l.agentId);
    const slugs = new Map<string, string>();
    if (ids.size)
      for (const a of await db
        .select({ id: agents.id, slug: agents.slug })
        .from(agents)
        .where(inArray(agents.id, [...ids])))
        slugs.set(a.id, a.slug);
    const slug = (v: unknown) => (typeof v === "string" ? (slugs.get(v) ?? v) : null);
    const linkView = (side: unknown) =>
      (
        (side as { kind: string; target?: string; agentId?: string; title?: string }[] | null) ?? []
      ).map((l) => ({
        kind: l.kind,
        ...(l.target ? { target: l.target } : {}),
        ...(l.agentId ? { agent: slugs.get(l.agentId) ?? l.agentId } : {}),
        ...(l.title ? { title: l.title } : {}),
      }));
    return rows.map((r) => ({
      id: r.id,
      event: r.type,
      actor: (r.agentSlug
        ? { kind: "agent", slug: r.agentSlug }
        : { kind: "user", handle: r.handle as string }) as PrincipalRef,
      at: r.at,
      ...(r.type === "assignee"
        ? { from: slug(r.from), to: slug(r.to) }
        : r.type === "links"
          ? { from: linkView(r.from), to: linkView(r.to) }
          : r.type === "body"
            ? {}
            : { from: r.from ?? undefined, to: r.to ?? undefined }),
    }));
  }

  private async agentId(actor: Actor, raw: string): Promise<string> {
    const name = raw.trim().replace(/^@/, "");
    if (name === "me") {
      if (actor.kind === "agent") return actor.agentId;
      throw new TaskError("reserved", "'me' is reserved; name an agent.", 400, "assignee");
    }
    const [a] = await this.d.db.select({ id: agents.id }).from(agents).where(eq(agents.slug, name));
    if (!a) throw new TaskError("not_found", `No agent @${name}.`, 400, "assignee");
    return a.id;
  }

  private async creator(
    actor: Actor,
    raw: string,
  ): Promise<{ agentId: string } | { userId: string }> {
    const name = raw.trim().replace(/^@/, "");
    if (name === "me")
      return actor.kind === "agent" ? { agentId: actor.agentId } : { userId: actor.userId };
    const [a] = await this.d.db.select({ id: agents.id }).from(agents).where(eq(agents.slug, name));
    const [u] = await this.d.db.select({ id: users.id }).from(users).where(eq(users.handle, name));
    if (a && u)
      throw new TaskError(
        "ambiguous",
        `'${name}' matches both an agent and a user.`,
        400,
        "creator",
      );
    if (a) return { agentId: a.id };
    if (u) return { userId: u.id };
    throw new TaskError("not_found", `No agent or user named '${name}'.`, 400, "creator");
  }
}
