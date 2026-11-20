import type { Db, TaskRow } from "@open-factory/db";
import { schema } from "@open-factory/db";
import {
  createTaskBodySchema,
  type LinkInput,
  parseTaskKey,
  patchTaskBodySchema,
  type TaskStatus,
  taskCommentBodySchema,
  taskKey,
} from "@open-factory/shared";
import { extractMentions } from "@open-factory/shared/mentions";
import { inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore, Exec, PendingRow } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { resolveName } from "../messaging/principals.ts";
import type { Router } from "../messaging/router.ts";
import { blockedBy, isBlocked } from "./blocked.ts";
import { TaskError } from "./errors.ts";
import { type PlannedRow, plan } from "./notifier.ts";
import { type Actor, canChange, forbiddenSentence } from "./permission.ts";
import { type ListFilter, TaskReads } from "./task-reads.ts";
import type { EventType, Principal, ResolvedLink, TaskStore } from "./task-store.ts";

const { agents, users } = schema;

export type TaskView = {
  key: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
  assigneeEnded?: "archived" | "terminated";
  blockedBy: string[];
};
export type ChangeResult = { task: TaskView; changed: string[]; note?: string };

export type CommentResult = {
  id: string;
  createdAt: Date;
  deliveredTo: string[];
  mentionedHumans: string[];
  notReached: {
    name: string;
    reason: "unknown" | "ambiguous" | "archived" | "terminated" | "reserved" | "too_many";
  }[];
  note?: string;
};

/** Spec §6.1: at most 50 distinct mentions are resolved per comment. */
const MAX_MENTIONS = 50;

export const CONFLICT_SENTENCE = "The task changed while you were editing it; try again.";

const isDeadlock = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "40P01" || e?.cause?.code === "40P01";
};

/** Spec §13.1: every task transaction is retried once from step 1 on a deadlock; a second one is a plain sentence. */
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isDeadlock(err)) throw err;
  }
  try {
    return await fn();
  } catch (err) {
    if (isDeadlock(err)) throw new TaskError("task_conflict", CONFLICT_SENTENCE, 409);
    throw err;
  }
}

type Input = {
  title?: string;
  body?: string;
  status?: TaskStatus;
  assignee?: string | null;
  dependsOn?: string[];
  links?: LinkInput[];
};

type Outcome = {
  view: TaskView;
  changed: string[];
  agentRows: { row: PendingRow; wake: "human" | "task_message" }[];
  humans: boolean;
  keys: string[];
  /** Recipients of a `task_assigned` row, for the errored note (computed after the commit). */
  assignedAgentIds: string[];
  assigneeSlug?: string;
  assigneeEnded?: "archived" | "terminated";
};

const principalOf = (a: Actor): Principal =>
  a.kind === "agent" ? { agentId: a.agentId } : { userId: a.userId };
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const settled = (s: TaskStatus) => s === "done" || s === "cancelled";

export class TaskService {
  private readonly reads: TaskReads;
  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      tasks: TaskStore;
      router: Router;
      runtimes: AgentRuntimes;
      bus: EventBus;
      log: FastifyBaseLogger;
    },
  ) {
    this.reads = new TaskReads({ db: d.db, tasks: d.tasks });
  }

  list(actor: Actor, filter: ListFilter) {
    return this.reads.list(actor, filter);
  }

  detail(key: string, o: Parameters<TaskReads["detail"]>[1]) {
    return this.reads.detail(key, o);
  }

  async create(
    actor: Actor,
    input: {
      title: string;
      body?: string;
      assignee?: string | null;
      dependsOn?: string[];
      links?: LinkInput[];
    },
  ): Promise<ChangeResult> {
    const parsed = createTaskBodySchema.safeParse(input);
    if (!parsed.success) throw validation(parsed.error);
    return this.run(actor, null, parsed.data);
  }

  async update(actor: Actor, key: string, patch: Input): Promise<ChangeResult> {
    const parsed = patchTaskBodySchema.safeParse(patch);
    if (!parsed.success) throw validation(parsed.error);
    return this.run(actor, key, parsed.data);
  }

  private async run(actor: Actor, key: string | null, input: Input): Promise<ChangeResult> {
    const out = await withDeadlockRetry(() =>
      this.d.db.transaction((tx) => this.procedure(tx, actor, key, input)),
    );
    const notes = await this.finish(
      out,
      // Every agent that gets a task message to wait on (not a human's comment, which starts recovery): a note when errored.
      [
        ...new Set(
          out.agentRows
            .filter((r) => r.wake === "task_message")
            .flatMap((r) => (r.row.toAgentId ? [r.row.toAgentId] : [])),
        ),
      ],
    );
    if (out.assigneeEnded && out.assigneeSlug)
      notes.push(`The assignee @${out.assigneeSlug} was ${out.assigneeEnded}.`);
    return {
      task: out.view,
      changed: out.changed,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }

  /**
   * After the commit: the errored notes (a runtime read, never inside the transaction, read before the hand-off
   * enqueues its wake), then the hand-offs and frames. Returns the notes.
   */
  private async finish(
    out: { agentRows: Outcome["agentRows"]; humans: boolean; keys: string[] },
    erroredCheck: string[],
  ): Promise<string[]> {
    const notes: string[] = [];
    for (const id of erroredCheck) {
      if ((await this.d.router.statusOfAgent(id)) === "errored")
        notes.push(
          `@${await this.slugOf(id)} is errored; it will see this when a human restarts it.`,
        );
    }
    this.d.router.handOffTaskRows(out.agentRows);
    if (out.humans) this.d.bus.publishAll({ type: "inbox_changed" });
    this.d.bus.publishAll({ type: "tasks_changed", keys: out.keys });
    return notes;
  }

  /**
   * Spec §6.6, §8: a comment on any task by anyone. Mentions are parsed outside the transaction (pure), resolved in it,
   * and reach the assignee, mentioned agents and mentioned humans; `notReached` says who it didn't and why.
   */
  async comment(actor: Actor, key: string, body: string): Promise<CommentResult> {
    const parsed = taskCommentBodySchema.safeParse({ body });
    if (!parsed.success) throw validation(parsed.error);
    const text = parsed.data.body;
    const mentions = extractMentions(text);
    const out = await withDeadlockRetry(() =>
      this.d.db.transaction((tx) => this.commentProcedure(tx, actor, key, text, mentions)),
    );
    const notes = await this.finish(
      out,
      out.agentRows
        .filter((r) => r.wake === "task_message")
        .flatMap((r) => (r.row.toAgentId ? [r.row.toAgentId] : [])),
    );
    return { ...out.result, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  private async commentProcedure(
    tx: Exec,
    actor: Actor,
    key: string,
    text: string,
    mentions: { names: string[]; skipped: string[] },
  ) {
    const T = this.d.tasks;
    const n = parseTaskKey(key);
    const pre = n === null ? undefined : await T.byNumber(tx, n);
    if (!pre) throw new TaskError("task_not_found", `No task ${key}.`, 404);
    // Step 3, with no dependents: the comment only needs the task row itself.
    const [task] = await T.lockTasks(tx, [pre.id]);
    if (!task) throw new TaskError("task_not_found", `No task ${key}.`, 404);

    const notReached: CommentResult["notReached"] = [];
    const candidates: { id: string; slug: string }[] = [];
    const userIds: string[] = [];
    const handles = new Map<string, string>();
    let all = false;
    const isAuthorAgent = (id: string) => actor.kind === "agent" && actor.agentId === id;
    const isAuthorUser = (id: string) => actor.kind === "user" && actor.userId === id;
    const names = mentions.names.slice(0, MAX_MENTIONS);
    for (const name of names) {
      const r = await resolveName(tx, name);
      switch (r.kind) {
        case "humans":
          all = true;
          break;
        case "user":
          if (!isAuthorUser(r.userId) && !userIds.includes(r.userId)) {
            userIds.push(r.userId);
            handles.set(r.userId, r.handle);
          }
          break;
        case "agent":
          if (!isAuthorAgent(r.agent.id) && !candidates.some((c) => c.id === r.agent.id))
            candidates.push({ id: r.agent.id, slug: r.agent.slug });
          break;
        case "reserved":
          notReached.push({ name, reason: "reserved" });
          break;
        case "ambiguous":
          notReached.push({ name, reason: "ambiguous" });
          break;
        case "none":
          notReached.push({ name, reason: "unknown" });
          break;
      }
    }
    for (const name of mentions.names.slice(MAX_MENTIONS))
      notReached.push({ name, reason: "too_many" });
    for (const name of mentions.skipped)
      if (!mentions.names.includes(name) && !notReached.some((x) => x.name === name))
        notReached.push({ name, reason: "unknown" });

    // Step 5: agents FOR SHARE in one statement.
    const involved = new Set<string>(candidates.map((c) => c.id));
    if (actor.kind === "agent") involved.add(actor.agentId);
    if (task.assigneeAgentId) involved.add(task.assigneeAgentId);
    const locked = await T.lockAgents(tx, [...involved]);
    const ended = new Map<string, "archived" | "terminated">();
    for (const a of locked) {
      if (a.terminatedAt) ended.set(a.id, "terminated");
      else if (a.archivedAt) ended.set(a.id, "archived");
    }
    if (actor.kind === "agent") {
      const e = ended.get(actor.agentId);
      if (e) throw new TaskError("ended", `You can't work on tasks: you were ${e}.`, 409);
    }
    const mentionedAgentIds: string[] = [];
    for (const c of candidates) {
      const e = ended.get(c.id);
      if (e) notReached.push({ name: c.slug, reason: e });
      else mentionedAgentIds.push(c.id);
    }
    if (task.assigneeAgentId) {
      const e = ended.get(task.assigneeAgentId);
      if (e && !isAuthorAgent(task.assigneeAgentId))
        notReached.push({ name: await this.slugOf(task.assigneeAgentId, tx), reason: e });
    }
    const live = new Set(locked.filter((a) => !ended.has(a.id)).map((a) => a.id));

    // Step 6.
    const principal = principalOf(actor);
    const comment = await T.insertComment(tx, { taskId: task.id, author: principal, body: text });
    await T.touch(tx, task.id);
    const deps = await T.dependencies(tx, task.id);
    const planned = await this.notify(tx, {
      actor,
      live,
      row: task,
      next: {
        title: task.title,
        body: task.body,
        status: task.status as TaskStatus,
        assigneeAgentId: task.assigneeAgentId,
      },
      before: {
        status: task.status as TaskStatus,
        assigneeId: task.assigneeAgentId,
        title: task.title,
        body: task.body,
      },
      deps,
      blocked: [],
      links: [],
      bodyChanged: false,
      unblocked: [],
      comment: {
        id: comment.id,
        body: text,
        mentionedAgentIds,
        mentionedUserIds: all ? "all" : userIds,
      },
    });
    const written = await this.write(tx, actor, planned);
    const deliveredTo: string[] = [];
    for (const r of written.agentRows) {
      const slug = await this.slugOf(r.row.toAgentId as string, tx);
      if (!deliveredTo.includes(slug)) deliveredTo.push(slug);
    }
    const mentionedHumans = !written.humans
      ? []
      : all
        ? ["@humans"]
        : userIds.map((u) => `@${handles.get(u)}`);
    return {
      agentRows: written.agentRows,
      humans: written.humans,
      keys: [taskKey(task.number)],
      result: {
        id: comment.id,
        createdAt: comment.createdAt,
        deliveredTo,
        mentionedHumans,
        notReached,
      },
    };
  }

  /** Inside a transaction, pass `tx`: a call on its own connection would wait on our uncommitted rows (§13.1). */
  private async slugOf(agentId: string, tx?: Exec): Promise<string> {
    return (await this.d.store.agentById(agentId, tx))?.slug ?? agentId;
  }

  /** Spec §13.1, in order. */
  private async procedure(
    tx: Exec,
    actor: Actor,
    key: string | null,
    input: Input,
  ): Promise<Outcome> {
    const T = this.d.tasks;
    // 1. Unlocked read of the acted-on task; which rows to lock comes from the input.
    let pre: TaskRow | undefined;
    if (key !== null) {
      const n = parseTaskKey(key);
      pre = n === null ? undefined : await T.byNumber(tx, n);
      if (!pre) throw new TaskError("task_not_found", `No task ${key}.`, 404);
    }
    const newDeps = input.dependsOn
      ? await this.resolveDeps(tx, input.dependsOn, pre?.number)
      : undefined;
    const links = input.links ? await this.resolveLinks(tx, input.links) : undefined;
    const assigneeId = await this.resolveAssignee(tx, actor, input.assignee);

    // 2. The advisory lock, only when depends_on changes.
    // Only an edit that can add or remove an edge takes the global lock: a create with no dependencies has none.
    if (newDeps && (pre || newDeps.length)) await T.lockGraph(tx);

    // 3. Task rows, FOR NO KEY UPDATE, in one sorted statement; newcomer dependents in a second one.
    const wantDependents = !!(pre && input.status);
    const first = [
      ...(pre ? [pre.id] : []),
      ...(wantDependents && pre ? (await T.dependents(tx, pre.id)).map((x) => x.id) : []),
      ...(newDeps?.map((x) => x.id) ?? []),
    ];
    const lockedRows = await T.lockTasks(tx, first);
    // The new dependencies' statuses as locked, not as read before the locks (a completion may have committed meanwhile).
    for (const d of newDeps ?? []) {
      const fresh = lockedRows.find((r) => r.id === d.id);
      if (fresh) d.status = fresh.status as TaskStatus;
    }
    let dependentIds: string[] = [];
    if (wantDependents && pre) {
      dependentIds = (await T.dependents(tx, pre.id)).map((x) => x.id);
      const newcomers = dependentIds.filter((id) => !first.includes(id));
      if (newcomers.length) lockedRows.push(...(await T.lockTasks(tx, newcomers)));
    }

    // 4. Re-read under the lock; everything below is computed from it.
    const before = pre ? lockedRows.find((r) => r.id === pre.id) : undefined;
    if (pre && !before) throw new TaskError("task_not_found", `No task ${key}.`, 404);
    const oldDeps = before ? await T.dependencies(tx, before.id) : [];
    const oldLinks = before ? await T.links(tx, before.id) : [];
    const dependents = before && wantDependents ? await T.dependents(tx, before.id) : [];

    if (before) {
      const managers = new Map<string, readonly string[]>();
      for (const who of [before.createdByAgentId, before.assigneeAgentId])
        if (who) managers.set(who, await T.managerChain(tx, who));
      if (!canChange(actor, before, (id) => managers.get(id) ?? [])) {
        const creator = await this.labelOf(
          tx,
          before.createdByAgentId
            ? { agentId: before.createdByAgentId }
            : { userId: before.createdByUserId as string },
        );
        const assignee = before.assigneeAgentId
          ? await this.labelOf(tx, { agentId: before.assigneeAgentId })
          : null;
        throw new TaskError(
          "task_forbidden",
          forbiddenSentence(taskKey(before.number), creator, assignee),
          403,
        );
      }
    }

    // What changes, against the locked row.
    const cur = before ?? {
      title: "",
      body: "",
      status: "open" as TaskStatus,
      assigneeAgentId: null as string | null,
    };
    const next = {
      title: input.title ?? cur.title,
      body: input.body ?? cur.body,
      status: (input.status ?? cur.status) as TaskStatus,
      assigneeAgentId: assigneeId === undefined ? cur.assigneeAgentId : assigneeId,
    };
    const changedTitle = !!before && next.title !== cur.title;
    const changedBody = !!before && next.body !== cur.body;
    const changedStatus = !!before && next.status !== cur.status;
    const changedAssignee = !!before && next.assigneeAgentId !== cur.assigneeAgentId;
    const newDepIds = newDeps?.map((x) => x.id);
    const changedDeps =
      !!newDepIds &&
      !!before &&
      !sameSet(
        newDepIds,
        oldDeps.map((x) => x.id),
      );
    const linkKey = (l: {
      kind: string;
      target?: string | null;
      agentId?: string | null;
      title?: string | null;
    }) => JSON.stringify([l.kind, l.target ?? null, l.agentId ?? null, l.title ?? null]);
    const changedLinks =
      !!links &&
      !!before &&
      JSON.stringify(links.map(linkKey)) !== JSON.stringify(oldLinks.map(linkKey));

    // 5. Agent rows FOR SHARE, persistent before spawned, in one statement; then re-check live.
    const unblockedCandidates: {
      id: string;
      number: number;
      title: string;
      assigneeAgentId: string | null;
    }[] = [];
    if (before && changedStatus && settled(next.status) && !settled(cur.status)) {
      const dstat = await T.depStatuses(
        tx,
        dependents.map((x) => x.id),
      );
      for (const dep of dependents) {
        if (dep.status !== "open" && dep.status !== "in_progress") continue;
        const list = dstat.get(dep.id) ?? [];
        const wasBlocked = isBlocked(
          dep.status,
          list.map((x) => x.status),
        );
        const nowBlocked = isBlocked(
          dep.status,
          list.map((x) => (x.number === before.number ? next.status : x.status)),
        );
        if (wasBlocked && !nowBlocked) unblockedCandidates.push(dep);
      }
    }
    // Dependencies removed from this task: it may have become unblocked.
    let removedUnblock: { cause: string } | undefined;
    if (
      before &&
      changedDeps &&
      newDeps &&
      (next.status === "open" || next.status === "in_progress")
    ) {
      const wasBlocked = isBlocked(
        cur.status,
        oldDeps.map((x) => x.status),
      );
      const nowBlocked = isBlocked(
        next.status,
        newDeps.map((x) => x.status),
      );
      if (wasBlocked && !nowBlocked) {
        const gone = oldDeps.find((o) => !newDeps.some((n) => n.id === o.id) && !settled(o.status));
        if (gone) removedUnblock = { cause: taskKey(gone.number) };
      }
    }

    const involved = new Set<string>();
    if (actor.kind === "agent") involved.add(actor.agentId);
    for (const id of [
      cur.assigneeAgentId,
      next.assigneeAgentId,
      before?.createdByAgentId ?? (actor.kind === "agent" ? actor.agentId : null),
      ...unblockedCandidates.map((x) => x.assigneeAgentId),
    ])
      if (id) involved.add(id);
    const lockedAgents = await T.lockAgents(tx, [...involved]);
    const ended = new Map<string, "archived" | "terminated">();
    for (const a of lockedAgents) {
      if (a.terminatedAt) ended.set(a.id, "terminated");
      else if (a.archivedAt) ended.set(a.id, "archived");
    }
    if (actor.kind === "agent") {
      const e = ended.get(actor.agentId);
      if (e) throw new TaskError("ended", `You can't work on tasks: you were ${e}.`, 409);
    }
    if (assigneeId && (!before || changedAssignee)) {
      const e = ended.get(assigneeId);
      if (e) {
        const slug = await this.slugOf(assigneeId, tx);
        throw new TaskError(
          "assignee_ended",
          `@${slug} was ${e} and can't be assigned tasks.`,
          409,
          "assignee",
        );
      }
    }
    const live = new Set(lockedAgents.filter((a) => !ended.has(a.id)).map((a) => a.id));

    // 6. Writes. Cycle check first (the graph lock is held).
    if (before && newDeps) {
      const added = newDeps.filter((n) => !oldDeps.some((o) => o.id === n.id)).map((n) => n.id);
      const path = await T.cyclePath(tx, before.id, added);
      if (path) throw new TaskError("cycle", cycleSentence(path), 400, "dependsOn");
    }

    let row: TaskRow;
    const events: { type: EventType; from?: unknown; to?: unknown }[] = [];
    const principal = principalOf(actor);
    if (!before) {
      row = await T.insertTask(tx, {
        title: next.title,
        body: next.body,
        assigneeAgentId: next.assigneeAgentId,
        createdBy: principal,
      });
      events.push({ type: "created" });
      if (next.assigneeAgentId)
        events.push({ type: "assignee", from: null, to: next.assigneeAgentId });
      if (newDeps?.length)
        events.push({ type: "depends_on", from: [], to: newDeps.map((x) => taskKey(x.number)) });
      if (links?.length) events.push({ type: "links", from: [], to: links });
    } else {
      row = before;
      const set: Partial<Pick<TaskRow, "title" | "body" | "status" | "assigneeAgentId">> = {};
      if (changedTitle) {
        set.title = next.title;
        events.push({ type: "title", from: cur.title, to: next.title });
      }
      if (changedBody) {
        set.body = next.body;
        events.push({ type: "body" });
      }
      if (changedStatus) {
        set.status = next.status;
        events.push({ type: "status", from: cur.status, to: next.status });
      }
      if (changedAssignee) {
        set.assigneeAgentId = next.assigneeAgentId;
        events.push({ type: "assignee", from: cur.assigneeAgentId, to: next.assigneeAgentId });
      }
      if (changedDeps)
        events.push({
          type: "depends_on",
          from: oldDeps.map((x) => taskKey(x.number)),
          to: newDeps?.map((x) => taskKey(x.number)),
        });
      if (changedLinks)
        events.push({
          type: "links",
          from: oldLinks.map((l) => ({
            kind: l.kind,
            target: l.target,
            agentId: l.agentId,
            title: l.title,
          })),
          to: links,
        });
      if (events.length) await T.updateTask(tx, before.id, set);
    }
    if (newDeps && (!before || changedDeps))
      await T.replaceDependencies(
        tx,
        row.id,
        newDeps.map((x) => x.id),
      );
    if (links && (!before || changedLinks)) await T.replaceLinks(tx, row.id, links);
    await T.insertEvents(
      tx,
      events.map((e) => ({ taskId: row.id, actor: principal, ...e })),
    );

    // Current dependencies, links and blocked state, after the write.
    const deps = await T.dependencies(tx, row.id);
    const blocked = blockedBy(
      next.status,
      deps.map((x) => ({ key: taskKey(x.number), status: x.status })),
    );
    const finalLinks = await T.links(tx, row.id);

    const changedNames = before
      ? [
          ...(changedTitle ? ["title"] : []),
          ...(changedBody ? ["body"] : []),
          ...(changedStatus ? ["status"] : []),
          ...(changedAssignee ? ["assignee"] : []),
          ...(changedDeps ? ["depends_on"] : []),
          ...(changedLinks ? ["links"] : []),
        ]
      : [];

    // Notifications.
    const planned =
      events.length || !before
        ? await this.notify(tx, {
            actor,
            live,
            row,
            next,
            before: before
              ? {
                  status: cur.status,
                  assigneeId: cur.assigneeAgentId,
                  title: cur.title,
                  body: cur.body,
                }
              : null,
            deps,
            blocked,
            links: finalLinks,
            bodyChanged: !before || changedBody,
            unblocked: [
              ...unblockedCandidates.map((u) => ({
                taskId: u.id,
                key: taskKey(u.number),
                title: u.title,
                assigneeId: u.assigneeAgentId,
                cause: taskKey(row.number),
                how: next.status === "cancelled" ? ("cancelled" as const) : ("done" as const),
              })),
              ...(removedUnblock
                ? [
                    {
                      taskId: row.id,
                      key: taskKey(row.number),
                      title: next.title,
                      assigneeId: next.assigneeAgentId,
                      cause: removedUnblock.cause,
                      how: "removed" as const,
                    },
                  ]
                : []),
            ],
          })
        : [];
    const written = await this.write(tx, actor, planned);

    const assigneeSlug = next.assigneeAgentId
      ? await this.slugOf(next.assigneeAgentId, tx)
      : undefined;
    const assigneeEnded = next.assigneeAgentId ? ended.get(next.assigneeAgentId) : undefined;
    const view: TaskView = {
      key: taskKey(row.number),
      title: next.title,
      status: next.status,
      ...(assigneeSlug ? { assignee: assigneeSlug } : {}),
      ...(assigneeEnded ? { assigneeEnded } : {}),
      blockedBy: blocked,
    };
    const keys = [
      taskKey(row.number),
      ...(changedStatus ? dependents.map((x) => taskKey(x.number)) : []),
      ...unblockedCandidates.map((u) => taskKey(u.number)),
    ];
    return {
      view,
      changed: changedNames,
      agentRows: written.agentRows,
      humans: written.humans,
      keys: [...new Set(keys)],
      assignedAgentIds: planned
        .filter((p) => p.kind === "task_assigned")
        .flatMap((p) =>
          "agentId" in (p.to as object) ? [(p.to as { agentId: string }).agentId] : [],
        ),
      ...(assigneeSlug ? { assigneeSlug } : {}),
      ...(assigneeEnded && changedNames.length ? { assigneeEnded } : {}),
    };
  }

  /** Builds `plan()`'s input from labels read in the transaction. */
  private async notify(
    tx: Exec,
    i: {
      actor: Actor;
      live: ReadonlySet<string>;
      row: TaskRow;
      next: { title: string; body: string; status: TaskStatus; assigneeAgentId: string | null };
      before: { status: TaskStatus; assigneeId: string | null; title: string; body: string } | null;
      deps: { number: number; status: TaskStatus; title: string }[];
      blocked: string[];
      links: Awaited<ReturnType<TaskStore["links"]>>;
      bodyChanged: boolean;
      unblocked: Parameters<typeof plan>[0]["unblocked"];
      comment?: Parameters<typeof plan>[0]["comment"];
    },
  ): Promise<PlannedRow[]> {
    const agentIds = new Set<string>(
      [
        i.row.createdByAgentId,
        i.before?.assigneeId,
        i.next.assigneeAgentId,
        i.actor.kind === "agent" ? i.actor.agentId : null,
        ...i.unblocked.map((u) => u.assigneeId),
      ].filter((x): x is string => !!x),
    );
    const slugs = new Map<string, string>();
    if (agentIds.size) {
      const rows = await tx
        .select({ id: agents.id, slug: agents.slug })
        .from(agents)
        .where(inArray(agents.id, [...agentIds]));
      for (const r of rows) slugs.set(r.id, `@${r.slug}`);
    }
    const label = (id: string) => slugs.get(id) ?? id;
    const creator: Principal = i.row.createdByAgentId
      ? { agentId: i.row.createdByAgentId }
      : { userId: i.row.createdByUserId as string };
    const creatorLabel = await this.labelOf(tx, creator);
    const author = i.bodyChanged
      ? principalOf(i.actor)
      : ((await this.d.tasks.bodyAuthor(tx, i.row.id)) ?? creator);
    return plan({
      actor: i.actor,
      actorLabel: i.actor.kind === "agent" ? `@${i.actor.slug}` : `@${i.actor.handle}`,
      live: i.live,
      task: {
        id: i.row.id,
        key: taskKey(i.row.number),
        title: i.next.title,
        body: i.next.body,
        creator,
        creatorLabel,
        bodyAuthorLabel: await this.labelOf(tx, author),
        deps: i.deps.map((x) => ({ key: taskKey(x.number), status: x.status })),
        blockedBy: i.blocked,
        links: i.links.map((l) => ({
          kind: l.kind,
          label: l.kind === "agent" ? `@${l.agentSlug}` : (l.target ?? ""),
          ...(l.title ? { title: l.title } : {}),
        })),
      },
      before: i.before,
      after: {
        status: i.next.status,
        assigneeId: i.next.assigneeAgentId,
        title: i.next.title,
        body: i.next.body,
      },
      label,
      unblocked: i.unblocked,
      ...(i.comment ? { comment: i.comment } : {}),
    });
  }

  /** Writes the planned rows: agent rows pending (handed over after the commit), human rows delivered with inbox items. */
  protected async write(
    tx: Exec,
    actor: Actor,
    planned: PlannedRow[],
  ): Promise<{
    agentRows: { row: PendingRow; wake: "human" | "task_message" }[];
    humans: boolean;
  }> {
    const agentRows: { row: PendingRow; wake: "human" | "task_message" }[] = [];
    let humans = false;
    for (const p of planned) {
      if (typeof p.to === "object" && "agentId" in p.to) {
        const row = await this.d.store.createTaskMessage(tx, {
          kind: p.kind,
          taskId: p.taskId,
          ...(p.commentId ? { commentId: p.commentId } : {}),
          ...(p.notice ? { notice: p.notice } : {}),
          ...(p.from ? { from: p.from } : {}),
          toAgentId: p.to.agentId,
          body: p.body,
        });
        agentRows.push({ row, wake: p.wake });
      } else {
        if (p.kind === "task_assigned") continue; // humans are never assignees
        const { row } = await this.d.store.createHumanMessage(
          {
            kind: p.kind,
            taskId: p.taskId,
            ...(p.commentId ? { commentId: p.commentId } : {}),
            ...(p.notice ? { notice: p.notice } : {}),
            ...(p.from && "agentId" in p.from ? { fromAgentId: p.from.agentId } : {}),
            ...(p.from && "userId" in p.from ? { fromUserId: p.from.userId } : {}),
            to: p.to === "all" ? "all" : { userId: p.to.userId },
            ...(p.exceptUserId ? { exceptUserId: p.exceptUserId } : {}),
            ...(p.inboxKind ? { inboxKind: p.inboxKind } : {}),
            body: p.body,
            urgent: false,
          },
          tx,
        );
        if (row) humans = true;
      }
    }
    void actor;
    return { agentRows, humans };
  }

  private async labelOf(tx: Exec, p: Principal): Promise<string> {
    if ("agentId" in p)
      return `@${(await this.d.store.agentById(p.agentId, tx))?.slug ?? p.agentId}`;
    const [u] = await tx
      .select({ handle: users.handle })
      .from(users)
      .where(inArray(users.id, [p.userId]));
    return `@${u?.handle ?? p.userId}`;
  }

  private async resolveDeps(tx: Exec, raw: string[], selfNumber?: number) {
    const numbers: number[] = [];
    for (const r of raw) {
      const n = parseTaskKey(r);
      if (n === null) throw new TaskError("no_task", `No task ${r}.`, 400, "dependsOn");
      if (n === selfNumber)
        throw new TaskError("self_dependency", "A task can't depend on itself.", 400, "dependsOn");
      if (!numbers.includes(n)) numbers.push(n);
    }
    const rows = await this.d.tasks.byNumbers(tx, numbers);
    for (const n of numbers)
      if (!rows.some((r) => r.number === n))
        throw new TaskError("no_task", `No task ${taskKey(n)}.`, 400, "dependsOn");
    const out = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        status: r.status as TaskStatus,
      })),
    );
    return out;
  }

  private async resolveLinks(tx: Exec, links: LinkInput[]): Promise<ResolvedLink[]> {
    const out: ResolvedLink[] = [];
    for (const l of links) {
      if (l.kind !== "agent") {
        out.push({ kind: l.kind, target: l.target, ...(l.title ? { title: l.title } : {}) });
        continue;
      }
      const r = await resolveName(tx, l.target);
      if (r.kind !== "agent")
        throw new TaskError(
          "no_agent",
          `No agent ${l.target.startsWith("@") ? l.target : `@${l.target}`}.`,
          400,
          "links",
        );
      out.push({ kind: "agent", agentId: r.agent.id, ...(l.title ? { title: l.title } : {}) });
    }
    return out;
  }

  /** `undefined`: not given. `null`: no assignee. Otherwise a live-or-ended agent id (liveness is re-checked under lock). */
  private async resolveAssignee(
    tx: Exec,
    actor: Actor,
    raw: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (raw === undefined || raw === null) return raw;
    const name = raw.trim().replace(/^@/, "");
    if (name === "me" && actor.kind === "agent") return actor.agentId;
    const r = await resolveName(tx, raw);
    switch (r.kind) {
      case "agent":
        return r.agent.id;
      case "user":
        throw new TaskError(
          "not_an_agent",
          `Tasks can only be assigned to agents; @${r.handle} is a human.`,
          400,
          "assignee",
        );
      case "humans":
        throw new TaskError(
          "not_an_agent",
          "Tasks can only be assigned to agents; @humans is not an agent.",
          400,
          "assignee",
        );
      case "reserved":
        throw new TaskError(
          "reserved",
          `'${r.name}' is reserved and can't receive messages.`,
          400,
          "assignee",
        );
      case "ambiguous":
        throw new TaskError(
          "ambiguous",
          `'${r.name}' matches both an agent and a user; ask a human to rename one.`,
          400,
          "assignee",
        );
      case "none":
        throw new TaskError(
          "not_found",
          `No agent or user named '${r.name}'. Call list_peers to see who you can message.`,
          400,
          "assignee",
        );
    }
  }
}

function cycleSentence(path: number[]): string {
  // path: the new dependency ... the task itself.
  const first = path[0] as number;
  const last = path[path.length - 1] as number;
  const mid = path.slice(1, -1).slice(0, 3).map(taskKey);
  const through = mid.length ? ` (through ${mid.join(", ")})` : "";
  return `${taskKey(first)} already depends on ${taskKey(last)}${through}; that would make a cycle.`;
}

function validation(err: import("zod").ZodError): TaskError {
  const issue = err.issues[0];
  const field = issue?.path[0];
  return new TaskError(
    "invalid",
    issue?.message ?? "Invalid input.",
    400,
    typeof field === "string" ? field : undefined,
  );
}
