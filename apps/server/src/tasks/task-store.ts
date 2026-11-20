/**
 * SQL for the five task tables, and the one lock order every task transaction follows (S8 spec §13.1).
 *
 *   1. Read the acted-on task without locks. Which task rows to lock is decided from the INPUT, never from this stale
 *      read: a `status` in the input locks the task's dependents, a `depends_on` locks the dependencies it adds.
 *   2. `pg_advisory_xact_lock(TASK_GRAPH_LOCK)`, only when `depends_on` changes (cycle checks must serialise).
 *   3. Task rows `FOR NO KEY UPDATE`, all in ONE statement ordered by id (`lockTasks`). Then re-read the dependents and
 *      lock any newcomers in a second sorted statement. The second statement is taken while task locks are already
 *      held, so it can deadlock against another transaction's first statement: that is expected and covered by the
 *      once-only retry in `TaskService` (`withDeadlockRetry`). Do not "fix" it with more locking.
 *   4. Re-read the task under its lock; run `canChange`, the recipients and the blocked states on the locked data.
 *   5. Agent rows `FOR SHARE` in ONE statement ordered persistent before spawned, then id (`lockAgents`): the caller and
 *      every agent written to or assigned. Re-check each is live.
 *   6. Inserts: messages and inbox items.
 *
 * Invariant: tasks before agents. No transaction may lock an agent row and then wait on a task row. Code that does
 * breaks this order and must change spec §13.
 * Two companion rules: never `FOR UPDATE` on `tasks` or `task_comments` (it conflicts with the `KEY SHARE` that S6/S7
 * statements take through their foreign keys), and never update `tasks.id`, `tasks.number` or
 * `task_comments.(task_id, id)`.
 *
 * Every method takes `tx` first, and every call inside a task transaction passes it (a call on its own connection
 * would wait forever on our uncommitted rows).
 */
import { randomUUID } from "node:crypto";
import { type Db, schema, type TaskCommentRow, type TaskRow } from "@open-factory/db";
import type { TaskStatus } from "@open-factory/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Exec } from "../agents/event-store.ts";

const { tasks, taskDependencies, taskLinks, taskComments, taskEvents, agents } = schema;

/** The fixed key of the dependency-edit advisory lock (spec §6.4). */
export const TASK_GRAPH_LOCK = 0x5348_0008;

/** `a, b, c` as bound parameters (drizzle expands a JS array into a tuple, not a Postgres array). */
const list = (xs: string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

export type Principal = { agentId: string } | { userId: string };
export type ResolvedLink = {
  kind: "url" | "pr" | "file" | "agent";
  target?: string;
  agentId?: string;
  title?: string;
};
export type EventType =
  | "created"
  | "status"
  | "assignee"
  | "title"
  | "body"
  | "depends_on"
  | "links";
export type LockedAgent = {
  id: string;
  kind: string;
  archivedAt: Date | null;
  terminatedAt: Date | null;
};
export type TaskNode = { id: string; number: number; title: string; status: TaskStatus };

export class TaskStore {
  constructor(private readonly d: { db: Db; clock: () => Date }) {}

  async byNumber(tx: Exec, n: number): Promise<TaskRow | undefined> {
    return (await tx.select().from(tasks).where(eq(tasks.number, n)))[0];
  }
  async byNumbers(tx: Exec, ns: number[]): Promise<TaskRow[]> {
    if (!ns.length) return [];
    return tx.select().from(tasks).where(inArray(tasks.number, ns)).orderBy(asc(tasks.number));
  }
  async byId(tx: Exec, id: string): Promise<TaskRow | undefined> {
    return (await tx.select().from(tasks).where(eq(tasks.id, id)))[0];
  }

  async insertTask(
    tx: Exec,
    t: { title: string; body: string; assigneeAgentId: string | null; createdBy: Principal },
  ): Promise<TaskRow> {
    const now = this.d.clock();
    const [row] = await tx
      .insert(tasks)
      .values({
        id: randomUUID(),
        title: t.title,
        body: t.body,
        assigneeAgentId: t.assigneeAgentId,
        createdByAgentId: "agentId" in t.createdBy ? t.createdBy.agentId : null,
        createdByUserId: "userId" in t.createdBy ? t.createdBy.userId : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row as TaskRow;
  }

  /** Bumps `updated_at`. */
  async updateTask(
    tx: Exec,
    id: string,
    set: Partial<Pick<TaskRow, "title" | "body" | "status" | "assigneeAgentId">>,
  ): Promise<void> {
    await tx
      .update(tasks)
      .set({ ...set, updatedAt: this.d.clock() })
      .where(eq(tasks.id, id));
  }
  async touch(tx: Exec, id: string): Promise<void> {
    await tx.update(tasks).set({ updatedAt: this.d.clock() }).where(eq(tasks.id, id));
  }

  /** ONE statement, ordered by id (§13.1 step 3). */
  async lockTasks(tx: Exec, ids: string[]): Promise<TaskRow[]> {
    if (!ids.length) return [];
    return tx
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [...new Set(ids)]))
      .orderBy(asc(tasks.id))
      .for("no key update");
  }

  /** ONE statement, persistent before spawned, then id (§13.1 step 5): S7's spawner-then-child order. */
  async lockAgents(tx: Exec, ids: string[]): Promise<LockedAgent[]> {
    if (!ids.length) return [];
    const rows = await tx.execute(sql`
      select id, kind, archived_at as "archivedAt", terminated_at as "terminatedAt" from agents
      where id in (${list([...new Set(ids)])}) order by (kind = 'ephemeral'), id for share`);
    return rows as unknown as LockedAgent[];
  }

  async lockGraph(tx: Exec): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${TASK_GRAPH_LOCK})`);
  }

  async dependencies(tx: Exec, taskId: string): Promise<TaskNode[]> {
    return tx
      .select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(eq(taskDependencies.taskId, taskId))
      .orderBy(asc(tasks.number));
  }
  async dependents(
    tx: Exec,
    taskId: string,
  ): Promise<(TaskNode & { assigneeAgentId: string | null })[]> {
    return tx
      .select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        assigneeAgentId: tasks.assigneeAgentId,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(taskDependencies.dependsOnTaskId, taskId))
      .orderBy(asc(tasks.number));
  }
  /** Each task's dependencies' numbers and statuses (for blocked states). */
  async depStatuses(
    tx: Exec,
    taskIds: string[],
  ): Promise<Map<string, { number: number; status: TaskStatus }[]>> {
    const out = new Map<string, { number: number; status: TaskStatus }[]>();
    if (!taskIds.length) return out;
    const rows = await tx
      .select({ taskId: taskDependencies.taskId, number: tasks.number, status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(inArray(taskDependencies.taskId, taskIds))
      .orderBy(asc(tasks.number));
    for (const r of rows) {
      const list = out.get(r.taskId) ?? [];
      list.push({ number: r.number, status: r.status });
      out.set(r.taskId, list);
    }
    return out;
  }

  /**
   * Does any new dependency already reach `taskId` through `depends_on` edges? Returns the task numbers along the
   * shortest path, from the new dependency to `taskId`, or null. `UNION` plus the path guard terminate on any graph.
   */
  async cyclePath(tx: Exec, taskId: string, newDepIds: string[]): Promise<number[] | null> {
    if (!newDepIds.length) return null;
    const r = await tx.execute(sql`
      with recursive walk(id, path) as (
        select d, array[d]::text[] from unnest(array[${list(newDepIds)}]::text[]) d
        union
        select td.depends_on_task_id, w.path || td.depends_on_task_id
        from walk w join task_dependencies td on td.task_id = w.id
        where not td.depends_on_task_id = any(w.path) and array_length(w.path, 1) < 1000)
      select path from walk where id = ${taskId} order by array_length(path, 1) limit 1`);
    const path = (r as unknown as { path: string[] }[])[0]?.path;
    if (!path) return null;
    const nums = await tx
      .select({ id: tasks.id, number: tasks.number })
      .from(tasks)
      .where(inArray(tasks.id, path));
    const byId = new Map(nums.map((n) => [n.id, n.number]));
    return path.map((id) => byId.get(id) as number);
  }

  async replaceDependencies(
    tx: Exec,
    taskId: string,
    depIds: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const want = [...new Set(depIds)];
    const have = (
      await tx
        .select({ id: taskDependencies.dependsOnTaskId })
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, taskId))
    ).map((r) => r.id);
    const added = want.filter((id) => !have.includes(id));
    const removed = have.filter((id) => !want.includes(id));
    if (removed.length)
      await tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.taskId, taskId),
            inArray(taskDependencies.dependsOnTaskId, removed),
          ),
        );
    if (added.length)
      await tx
        .insert(taskDependencies)
        .values(added.map((dependsOnTaskId) => ({ taskId, dependsOnTaskId })));
    return { added, removed };
  }

  async replaceLinks(tx: Exec, taskId: string, links: ResolvedLink[]): Promise<void> {
    await tx.delete(taskLinks).where(eq(taskLinks.taskId, taskId));
    if (!links.length) return;
    await tx.insert(taskLinks).values(
      links.map((l, position) => ({
        id: randomUUID(),
        taskId,
        position,
        kind: l.kind,
        target: l.kind === "agent" ? null : (l.target ?? null),
        agentId: l.kind === "agent" ? (l.agentId ?? null) : null,
        title: l.title ?? null,
      })),
    );
  }
  /** In the order given, with the linked agent's slug and ended state. */
  async links(tx: Exec, taskId: string) {
    return tx
      .select({
        id: taskLinks.id,
        position: taskLinks.position,
        kind: taskLinks.kind,
        target: taskLinks.target,
        title: taskLinks.title,
        agentId: taskLinks.agentId,
        agentSlug: agents.slug,
        agentDisplayName: agents.displayName,
        agentArchivedAt: agents.archivedAt,
        agentTerminatedAt: agents.terminatedAt,
      })
      .from(taskLinks)
      .leftJoin(agents, eq(agents.id, taskLinks.agentId))
      .where(eq(taskLinks.taskId, taskId))
      .orderBy(asc(taskLinks.position));
  }

  async insertComment(
    tx: Exec,
    c: { taskId: string; author: Principal; body: string },
  ): Promise<TaskCommentRow> {
    const [row] = await tx
      .insert(taskComments)
      .values({
        id: randomUUID(),
        taskId: c.taskId,
        authorAgentId: "agentId" in c.author ? c.author.agentId : null,
        authorUserId: "userId" in c.author ? c.author.userId : null,
        body: c.body,
        createdAt: this.d.clock(),
      })
      .returning();
    return row as TaskCommentRow;
  }

  async insertEvents(
    tx: Exec,
    rows: { taskId: string; actor: Principal; type: EventType; from?: unknown; to?: unknown }[],
  ): Promise<void> {
    if (!rows.length) return;
    await tx.insert(taskEvents).values(
      rows.map((r) => ({
        id: randomUUID(),
        taskId: r.taskId,
        actorAgentId: "agentId" in r.actor ? r.actor.agentId : null,
        actorUserId: "userId" in r.actor ? r.actor.userId : null,
        type: r.type,
        fromValue: r.from ?? null,
        toValue: r.to ?? null,
        at: this.d.clock(),
      })),
    );
  }

  /** The managers above an agent, nearest first (the transitive `reports_to` chain, in the caller's transaction). */
  async managerChain(tx: Exec, agentId: string): Promise<string[]> {
    const r = await tx.execute(sql`
      with recursive up(id, depth) as (
        select reports_to, 1 from agents where id = ${agentId} and reports_to is not null
        union
        select a.reports_to, up.depth + 1 from up join agents a on a.id = up.id where a.reports_to is not null)
      select id from up order by depth`);
    return (r as unknown as { id: string }[]).map((x) => x.id);
  }
}
