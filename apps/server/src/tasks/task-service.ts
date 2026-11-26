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
import { agentTagOf, tagOf, unknownRefError } from "@open-factory/shared/tags";
import { eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore, Exec, PendingRow, Tx } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { type GuardResult, type LoopGuard, loopNotes, pairOf } from "../messaging/loop-guard.ts";
import type { Router } from "../messaging/router.ts";
import { resolveArg } from "../principals/principal-args.ts";
import { principalsByIds, principalsByRefs } from "../principals/principal-store.ts";
import { resolveField } from "../principals/principal-text.ts";
import { blockedBy, isBlocked } from "./blocked.ts";
import { TaskError } from "./errors.ts";
import type { Who } from "./notifier.ts";
import { type PlannedRow, plan } from "./notifier.ts";
import { type Actor, canChange, forbiddenSentence } from "./permission.ts";
import { type ListFilter, TaskReads } from "./task-reads.ts";
import type { EventType, ResolvedLink, TaskStore } from "./task-store.ts";

export type TaskView = {
  key: string;
  title: string;
  status: TaskStatus;
  /** The assignee's principal; an MCP result writes it as its tag. */
  assignee?: { ref: string; handle: string };
  assigneeEnded?: "archived" | "terminated";
  blockedBy: string[];
};
export type ChangeResult = {
  task: TaskView;
  changed: string[];
  note?: string;
  /** Plain-tag warnings for a name written without a tag; absent when there are none. */
  warnings?: string[];
};

export type CommentResult = {
  id: string;
  /** The stored text: every tag as `<@ref>`. */
  body: string;
  createdAt: Date;
  deliveredTo: { ref: string; handle: string }[];
  mentionedHumans: { ref: string; handle: string }[];
  notReached: { name: string; reason: "archived" | "terminated" | "too_many" }[];
  /** Agent recipients the loop guard parked (I8 §6.3): the comment is posted, their copy waits for a human's Resume. */
  held: { to: string; note: string }[];
  note?: string;
  /** Plain-tag warnings for a name written without a tag; absent when there are none. */
  warnings?: string[];
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
  /** Users a human row was written for. */
  userIds: string[];
  keys: string[];
  /** Recipients of a `task_assigned` row, for the errored note (computed after the commit). */
  assignedAgentIds: string[];
  assigneeHandle?: string;
  assigneeEnded?: "archived" | "terminated";
};

const principalOf = (a: Actor): Who => ({ kind: a.kind, id: a.id });
/** The messages layer's shape for a sender or recipient. */
const messageParty = (w: Who) => (w.kind === "agent" ? { agentId: w.id } : { userId: w.id });
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
      loopGuard: LoopGuard;
    },
  ) {
    this.reads = new TaskReads({ db: d.db, tasks: d.tasks });
  }

  list(actor: Actor, filter: ListFilter, warnings?: string[]) {
    return this.reads.list(actor, filter, warnings);
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
    const warnings: string[] = [];
    const out = await withDeadlockRetry(() =>
      this.d.db.transaction((tx) => this.procedure(tx, actor, key, input, warnings)),
    );
    const notes = await this.finish(
      out,
      // Every agent that gets a task message to wait on (not a human's comment, which starts recovery): a note when errored.
      [
        ...new Set(
          out.agentRows
            .filter((r) => r.wake === "task_message")
            .flatMap((r) => (r.row.toId ? [r.row.toId] : [])),
        ),
      ],
    );
    if (out.assigneeEnded && out.assigneeHandle)
      notes.push(`The assignee @${out.assigneeHandle} was ${out.assigneeEnded}.`);
    return {
      task: out.view,
      changed: out.changed,
      ...(notes.length ? { note: notes.join(" ") } : {}),
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    };
  }

  /**
   * After the commit: the errored notes (a runtime read, never inside the transaction, read before the hand-off
   * enqueues its wake), then the hand-offs and frames. Returns the notes.
   */
  private async finish(
    out: { agentRows: Outcome["agentRows"]; userIds: string[]; keys: string[] },
    erroredCheck: string[],
  ): Promise<string[]> {
    const notes: string[] = [];
    for (const id of erroredCheck) {
      if ((await this.d.router.statusOfAgent(id)) === "errored")
        notes.push(
          `@${await this.handleOf(id)} is errored; it will see this after it is restarted (restart_agent, or a human).`,
        );
    }
    this.d.router.handOffTaskRows(out.agentRows);
    for (const userId of out.userIds) this.d.bus.publishToUser(userId, { type: "inbox_changed" });
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
    const warnings: string[] = [];
    const out = await withDeadlockRetry(() =>
      this.d.db.transaction((tx) =>
        this.commentProcedure(tx, actor, key, parsed.data.body, warnings),
      ),
    );
    const notes = await this.finish(
      out,
      out.agentRows
        .filter((r) => r.wake === "task_message")
        .flatMap((r) => (r.row.toId ? [r.row.toId] : [])),
    );
    this.d.loopGuard.afterCommit(out.guards);
    return {
      ...out.result,
      ...(notes.length ? { note: notes.join(" ") } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async commentProcedure(
    tx: Tx,
    actor: Actor,
    key: string,
    raw: string,
    warnings: string[],
  ) {
    const T = this.d.tasks;
    const n = parseTaskKey(key);
    const pre = n === null ? undefined : await T.byNumber(tx, n);
    if (!pre) throw new TaskError("task_not_found", `No task ${key}.`, 404);
    // Step 3, with no dependents: the comment only needs the task row itself.
    const [task] = await T.lockTasks(tx, [pre.id]);
    if (!task) throw new TaskError("task_not_found", `No task ${key}.`, 404);

    // The tags are the mentions: the stored text and the refs they name (an unknown ref refuses the comment).
    const { text, refs } = await resolveField(tx, raw, actor.kind, "body", warnings);
    const notReached: CommentResult["notReached"] = [];
    const candidates: { id: string; handle: string }[] = [];
    const userIds: string[] = [];
    const handles = new Map<string, { ref: string; handle: string }>();
    const isAuthorAgent = (id: string) => actor.kind === "agent" && actor.id === id;
    const isAuthorUser = (id: string) => actor.kind === "human" && actor.id === id;
    const tagged = await principalsByRefs(tx, refs);
    const reached = refs.slice(0, MAX_MENTIONS).flatMap((r) => tagged.get(r) ?? []);
    const agentRows = reached.length
      ? await tx
          .select()
          .from(schema.agents)
          .where(
            inArray(
              schema.agents.id,
              reached.map((p) => p.id),
            ),
          )
      : [];
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    for (const p of reached) {
      const agent = agentById.get(p.id);
      if (!agent) {
        if (!isAuthorUser(p.id) && !userIds.includes(p.id)) {
          userIds.push(p.id);
          handles.set(p.id, { ref: p.ref, handle: p.handle });
        }
      } else if (!isAuthorAgent(agent.id) && !candidates.some((c) => c.id === agent.id))
        candidates.push({ id: agent.id, handle: p.handle });
    }
    for (const r of refs.slice(MAX_MENTIONS))
      notReached.push({ name: tagged.get(r)?.handle ?? r, reason: "too_many" });

    // Step 5: agents FOR SHARE in one statement.
    const involved = new Set<string>(candidates.map((c) => c.id));
    if (actor.kind === "agent") involved.add(actor.id);
    if (task.assigneeAgentId) involved.add(task.assigneeAgentId);
    const locked = await T.lockAgents(tx, [...involved]);
    const ended = new Map<string, "archived" | "terminated">();
    for (const a of locked) {
      if (a.terminatedAt) ended.set(a.id, "terminated");
      else if (a.archivedAt) ended.set(a.id, "archived");
    }
    if (actor.kind === "agent") {
      const e = ended.get(actor.id);
      if (e) throw new TaskError("ended", `You can't work on tasks: you were ${e}.`, 409);
    }
    const mentionedAgentIds: string[] = [];
    for (const c of candidates) {
      const e = ended.get(c.id);
      if (e) notReached.push({ name: c.handle, reason: e });
      else mentionedAgentIds.push(c.id);
    }
    if (task.assigneeAgentId) {
      const e = ended.get(task.assigneeAgentId);
      if (e && !isAuthorAgent(task.assigneeAgentId))
        notReached.push({ name: await this.handleOf(task.assigneeAgentId, tx), reason: e });
    }
    const live = new Set(locked.filter((a) => !ended.has(a.id)).map((a) => a.id));

    // Step 6.
    const principal = principalOf(actor);
    const comment = await T.insertComment(tx, {
      taskId: task.id,
      authorId: principal.id,
      body: text,
    });
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
        mentionedUserIds: userIds,
      },
    });
    const written = await this.write(tx, actor, planned);
    const deliveredTo: { ref: string; handle: string }[] = [];
    for (const r of written.agentRows) {
      const p = await this.principalOfAgent(r.row.toId as string, tx);
      if (!deliveredTo.some((d) => d.ref === p.ref))
        deliveredTo.push({ ref: p.ref, handle: p.handle });
    }
    const mentionedHumans = userIds
      .filter((u) => written.userIds.includes(u))
      .flatMap((u) => handles.get(u) ?? []);
    const held: CommentResult["held"] = [];
    for (const g of written.loopHeld) {
      const to = await this.tagOf(tx, g.toAgentId);
      held.push({
        to,
        note: g.verdict.opened
          ? loopNotes.tripping(
              to,
              g.verdict.counts.ab + g.verdict.counts.ba,
              g.verdict.counts.minutes,
            )
          : loopNotes.later(to),
      });
    }
    return {
      agentRows: written.agentRows,
      userIds: written.userIds,
      keys: [taskKey(task.number)],
      guards: written.loopHeld.map((g) => g.verdict),
      result: {
        id: comment.id,
        body: text,
        createdAt: comment.createdAt,
        deliveredTo,
        mentionedHumans,
        notReached,
        held,
      },
    };
  }

  /** Inside a transaction, pass `tx`: a call on its own connection would wait on our uncommitted rows (§13.1). */
  private async principalOfAgent(
    agentId: string,
    tx: Exec = this.d.db,
  ): Promise<{ ref: string; handle: string }> {
    const p = (await principalsByIds(tx, [agentId])).get(agentId);
    if (!p) throw new Error(`No principal ${agentId}`);
    return p;
  }

  private async handleOf(agentId: string, tx?: Exec): Promise<string> {
    return (await this.principalOfAgent(agentId, tx)).handle;
  }

  /** Spec §13.1, in order. */
  private async procedure(
    tx: Tx,
    actor: Actor,
    key: string | null,
    input: Input,
    warnings: string[],
  ): Promise<Outcome> {
    const T = this.d.tasks;
    // Spec §4.3: the tags in the title and the body are stored as `<@ref>`; an unknown ref refuses the write.
    const tagged: Input = { ...input };
    if (input.title !== undefined)
      tagged.title = (await resolveField(tx, input.title, actor.kind, "title", warnings)).text;
    if (input.body !== undefined)
      tagged.body = (await resolveField(tx, input.body, actor.kind, "body", warnings)).text;
    input = tagged;
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
    const links = input.links ? await this.resolveLinks(tx, input.links, warnings) : undefined;
    const assigneeId = await this.resolveAssignee(tx, actor, input.assignee, warnings);

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
      for (const who of [before.createdById, before.assigneeAgentId])
        if (who) managers.set(who, await T.managerChain(tx, who));
      if (!canChange(actor, before, (id) => managers.get(id) ?? [])) {
        const creator = await this.labelOf(tx, before.createdById);
        const assignee = before.assigneeAgentId
          ? await this.labelOf(tx, before.assigneeAgentId)
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
    if (actor.kind === "agent") involved.add(actor.id);
    for (const id of [
      cur.assigneeAgentId,
      next.assigneeAgentId,
      before?.createdById ?? (actor.kind === "agent" ? actor.id : null),
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
      const e = ended.get(actor.id);
      if (e) throw new TaskError("ended", `You can't work on tasks: you were ${e}.`, 409);
    }
    if (assigneeId && (!before || changedAssignee)) {
      const e = ended.get(assigneeId);
      if (e) {
        const handle = await this.handleOf(assigneeId, tx);
        throw new TaskError(
          "assignee_ended",
          `@${handle} was ${e} and can't be assigned tasks.`,
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
        createdById: principal.id,
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
      events.map((e) => ({ taskId: row.id, actorId: principal.id, ...e })),
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

    const assignee = next.assigneeAgentId
      ? await this.principalOfAgent(next.assigneeAgentId, tx)
      : undefined;
    const assigneeHandle = assignee?.handle;
    const assigneeEnded = next.assigneeAgentId ? ended.get(next.assigneeAgentId) : undefined;
    const view: TaskView = {
      key: taskKey(row.number),
      title: next.title,
      status: next.status,
      ...(assignee ? { assignee: { ref: assignee.ref, handle: assignee.handle } } : {}),
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
      userIds: written.userIds,
      keys: [...new Set(keys)],
      assignedAgentIds: planned
        .filter((p) => p.kind === "task_assigned")
        .flatMap((p) => (p.to.kind === "agent" ? [p.to.id] : [])),
      ...(assigneeHandle ? { assigneeHandle } : {}),
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
    const authorId = i.bodyChanged
      ? i.actor.id
      : ((await this.d.tasks.bodyAuthor(tx, i.row.id)) ?? i.row.createdById);
    const ids = new Set<string>(
      [
        i.row.createdById,
        authorId,
        i.before?.assigneeId,
        i.next.assigneeAgentId,
        i.actor.kind === "agent" ? i.actor.id : null,
        ...i.unblocked.map((u) => u.assigneeId),
        ...i.links.map((l) => l.agentId),
      ].filter((x): x is string => !!x),
    );
    const people = await principalsByIds(tx, [...ids]);
    // A principal named in a stored body is its tag, so the text shows the current handle wherever it is read.
    const label = (id: string) => {
      const p = people.get(id);
      return p ? tagOf(p.ref) : id;
    };
    const creatorPerson = people.get(i.row.createdById);
    const creator: Who = {
      kind: creatorPerson?.kind ?? "human",
      id: i.row.createdById,
    };
    return plan({
      actor: i.actor,
      actorLabel: tagOf(i.actor.ref),
      live: i.live,
      task: {
        id: i.row.id,
        key: taskKey(i.row.number),
        title: i.next.title,
        body: i.next.body,
        creator,
        creatorLabel: label(i.row.createdById),
        bodyAuthorLabel: label(authorId),
        deps: i.deps.map((x) => ({ key: taskKey(x.number), status: x.status })),
        blockedBy: i.blocked,
        links: i.links.map((l) => ({
          kind: l.kind,
          label: l.kind === "agent" && l.agentId ? label(l.agentId) : (l.target ?? ""),
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
    tx: Tx,
    actor: Actor,
    planned: PlannedRow[],
  ): Promise<{
    agentRows: { row: PendingRow; wake: "human" | "task_message" }[];
    userIds: string[];
    loopHeld: { toAgentId: string; verdict: Extract<GuardResult, { held: true }> }[];
  }> {
    const agentRows: { row: PendingRow; wake: "human" | "task_message" }[] = [];
    const loopHeld: { toAgentId: string; verdict: Extract<GuardResult, { held: true }> }[] = [];
    const userIds = new Set<string>();
    // I8 §6.3: an agent's comment is counted and checked per agent recipient; every pair is locked first, once.
    const guarded = (p: PlannedRow): p is PlannedRow & { to: Who } =>
      p.kind === "task_comment" &&
      actor.kind === "agent" &&
      p.to.kind === "agent" &&
      p.to.id !== actor.id;
    if (actor.kind === "agent")
      await this.d.loopGuard.lockPairs(
        tx,
        planned.filter(guarded).map((p) => pairOf(actor.id, p.to.id)),
      );
    for (const p of planned) {
      if (p.to.kind === "agent") {
        const verdict =
          actor.kind === "agent" && guarded(p)
            ? await this.d.loopGuard.check(tx, actor.id, p.to.id)
            : undefined;
        const row = await this.d.store.createTaskMessage(tx, {
          kind: p.kind,
          taskId: p.taskId,
          ...(p.commentId ? { commentId: p.commentId } : {}),
          ...(p.notice ? { notice: p.notice } : {}),
          ...(p.from ? { from: messageParty(p.from) } : {}),
          toAgentId: p.to.id,
          body: p.body,
          ...(verdict?.held ? { state: "loop_held", loopHoldId: verdict.holdId } : {}),
        });
        if (verdict?.held) loopHeld.push({ toAgentId: p.to.id, verdict });
        else agentRows.push({ row, wake: p.wake });
      } else {
        if (p.kind === "task_assigned") continue; // humans are never assignees
        await this.d.store.createHumanMessage(
          {
            kind: p.kind,
            taskId: p.taskId,
            ...(p.commentId ? { commentId: p.commentId } : {}),
            ...(p.notice ? { notice: p.notice } : {}),
            ...(p.from?.kind === "agent" ? { fromAgentId: p.from.id } : {}),
            ...(p.from?.kind === "human" ? { fromUserId: p.from.id } : {}),
            to: { userId: p.to.id },
            ...(p.inboxKind ? { inboxKind: p.inboxKind } : {}),
            body: p.body,
            urgent: false,
          },
          tx,
        );
        userIds.add(p.to.id);
      }
    }
    return { agentRows, userIds: [...userIds], loopHeld };
  }

  /** `<@ref|handle>` of a principal, read from `principals`, as an agent reads it. */
  private async tagOf(tx: Exec, id: string): Promise<string> {
    const p = (await principalsByIds(tx, [id])).get(id);
    if (!p) throw new Error(`No principal ${id}`);
    return agentTagOf(p);
  }

  /** `@handle` of a principal, read from `principals` . */
  private async labelOf(tx: Exec, id: string): Promise<string> {
    const p = (await principalsByIds(tx, [id])).get(id);
    return `@${p?.handle ?? id}`;
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

  private async resolveLinks(
    tx: Exec,
    links: LinkInput[],
    warnings: string[],
  ): Promise<ResolvedLink[]> {
    const out: ResolvedLink[] = [];
    for (const l of links) {
      if (l.kind !== "agent") {
        out.push({ kind: l.kind, target: l.target, ...(l.title ? { title: l.title } : {}) });
        continue;
      }
      const r = await resolveArg(tx, l.target);
      if (r.kind === "unknown_ref")
        throw new TaskError("no_agent", unknownRefError(r.ref), 400, "links");
      const agent = r.kind === "principal" ? await this.agentRowOf(tx, r.p.id) : undefined;
      if (r.kind !== "principal" || !agent)
        throw new TaskError(
          "no_agent",
          `No agent @${r.kind === "principal" ? r.p.handle : "name" in r ? r.name : l.target.trim().replace(/^@/, "")}.`,
          400,
          "links",
        );
      if (r.warning) warnings.push(r.warning);
      out.push({ kind: "agent", agentId: agent.id, ...(l.title ? { title: l.title } : {}) });
    }
    return out;
  }

  private async agentRowOf(tx: Exec, id: string) {
    return (
      await tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, id))
    )[0];
  }

  /** `undefined`: not given. `null`: no assignee. Otherwise a live-or-ended agent id (liveness is re-checked under lock). */
  private async resolveAssignee(
    tx: Exec,
    actor: Actor,
    raw: string | null | undefined,
    warnings: string[],
  ): Promise<string | null | undefined> {
    if (raw === undefined || raw === null) return raw;
    const name = raw.trim().replace(/^@/, "");
    if (name === "me" && actor.kind === "agent") return actor.id;
    const r = await resolveArg(tx, raw);
    switch (r.kind) {
      case "principal": {
        const agent = await this.agentRowOf(tx, r.p.id);
        if (!agent)
          throw new TaskError(
            "not_an_agent",
            `Tasks can only be assigned to agents; @${r.p.handle} is a human.`,
            400,
            "assignee",
          );
        if (r.warning) warnings.push(r.warning);
        return agent.id;
      }
      case "unknown_ref":
        throw new TaskError("not_found", unknownRefError(r.ref), 400, "assignee");
      case "reserved":
        throw new TaskError(
          "reserved",
          `'${r.name}' is reserved and can't receive messages.`,
          400,
          "assignee",
        );
      case "channel":
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
