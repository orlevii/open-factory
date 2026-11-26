import type { TaskNotice, TaskStatus } from "@open-factory/shared";
import { taskAssignedBody, taskUpdateBody, type UpdateLine } from "./bodies.ts";
import type { Actor } from "./permission.ts";

/** A principal named by its id and kind (an agent's id is its `agents.id`). */
export type Who = { kind: "agent" | "human"; id: string };
export type Recipient = Who;

export type PlannedRow = {
  kind: "task_assigned" | "task_comment" | "task_update";
  taskId: string;
  to: Recipient;
  notice?: TaskNotice;
  commentId?: string;
  from?: Who;
  body: string;
  inboxKind?: "mention" | "task_event";
  /** A human's comment to an agent wakes it as a human message; everything else as a task message. */
  wake: "human" | "task_message";
};

type TaskInfo = {
  id: string;
  key: string;
  title: string;
  body: string;
  creator: Who;
  creatorLabel: string;
  bodyAuthorLabel: string;
  deps: { key: string; status: TaskStatus }[];
  blockedBy: string[];
  links: { kind: string; label: string; title?: string }[];
};

type Snapshot = { status: TaskStatus; assigneeId: string | null; title: string; body: string };

export type PlanInput = {
  actor: Actor;
  actorLabel: string;
  /** Agent ids that are live under the lock. */
  live: ReadonlySet<string>;
  task: TaskInfo;
  /** null = the task was just created. */
  before: Snapshot | null;
  after: Snapshot;
  label: (agentId: string) => string;
  unblocked: {
    taskId: string;
    key: string;
    title: string;
    assigneeId: string | null;
    cause: string;
    how: "done" | "cancelled" | "removed";
  }[];
  comment?: {
    id: string;
    body: string;
    mentionedAgentIds: string[];
    mentionedUserIds: string[];
  };
};

/** Highest first (spec §7.1). */
const PRECEDENCE: TaskNotice[] = [
  "unassigned",
  "done",
  "cancelled",
  "unblocked",
  "status_changed",
  "edited",
];

type Entry = {
  to: Who;
  taskId: string;
  key: string;
  title: string;
  assigned: boolean;
  lines: UpdateLine[];
  notices: TaskNotice[];
  editedBody?: { author: string; body: string };
  inboxKind?: "task_event";
};

/**
 * Spec §7.1: from a change, its actor and the task's people, the message rows to write. Pure. Never to the actor, never
 * to an agent that isn't live, at most one row per recipient per task per action.
 */
export function plan(i: PlanInput): PlannedRow[] {
  const entries = new Map<string, Entry>();
  const isActorAgent = (id: string) => i.actor.kind === "agent" && i.actor.id === id;
  const isActorHuman = (id: string) => i.actor.kind === "human" && i.actor.id === id;
  const agentOk = (id: string | null): id is string => !!id && !isActorAgent(id) && i.live.has(id);

  const entryFor = (to: Entry["to"], task: { id: string; key: string; title: string }): Entry => {
    const k = `${to.kind === "agent" ? "a" : "u"}:${to.id}|${task.id}`;
    let e = entries.get(k);
    if (!e) {
      e = {
        to,
        taskId: task.id,
        key: task.key,
        title: task.title,
        assigned: false,
        lines: [],
        notices: [],
      };
      entries.set(k, e);
    }
    return e;
  };
  const addLine = (e: Entry, line: UpdateLine, notice: TaskNotice) => {
    if (!e.lines.some((l) => JSON.stringify(l) === JSON.stringify(line))) e.lines.push(line);
    if (!e.notices.includes(notice)) e.notices.push(notice);
  };
  const t = { id: i.task.id, key: i.task.key, title: i.after.title };
  const { before, after } = i;

  if (!before) {
    if (agentOk(after.assigneeId))
      entryFor({ kind: "agent", id: after.assigneeId }, t).assigned = true;
  } else {
    // Assignment.
    if (before.assigneeId !== after.assigneeId) {
      if (agentOk(after.assigneeId))
        entryFor({ kind: "agent", id: after.assigneeId }, t).assigned = true;
      if (agentOk(before.assigneeId)) {
        const e = entryFor({ kind: "agent", id: before.assigneeId }, t);
        addLine(
          e,
          after.assigneeId
            ? { k: "reassigned", actor: i.actorLabel, to: i.label(after.assigneeId) }
            : { k: "unassigned", actor: i.actorLabel },
          "unassigned",
        );
      }
    }
    // Changes the current assignee is told about.
    if (agentOk(after.assigneeId)) {
      const e = entryFor({ kind: "agent", id: after.assigneeId }, t);
      if (before.status !== after.status) statusLine(e, i, after.status);
      if (before.title !== after.title)
        addLine(e, { k: "renamed", actor: i.actorLabel, to: after.title }, "edited");
      if (before.body !== after.body) {
        addLine(e, { k: "edited", actor: i.actorLabel }, "edited");
        e.editedBody = { author: i.actorLabel, body: after.body };
      }
    }
    // Done or cancelled: the creator hears of it.
    if (
      before.status !== after.status &&
      (after.status === "done" || after.status === "cancelled")
    ) {
      const c = i.task.creator;
      if (c.kind === "agent") {
        if (agentOk(c.id)) statusLine(entryFor(c, t), i, after.status);
      } else if (!isActorHuman(c.id)) {
        const e = entryFor(c, t);
        e.inboxKind = "task_event";
        statusLine(e, i, after.status);
      }
    }
  }

  for (const u of i.unblocked) {
    if (!agentOk(u.assigneeId)) continue;
    addLine(
      entryFor({ kind: "agent", id: u.assigneeId }, { id: u.taskId, key: u.key, title: u.title }),
      { k: "unblocked", cause: u.cause, how: u.how },
      "unblocked",
    );
  }

  const rows: PlannedRow[] = [];
  for (const e of entries.values()) {
    if (e.assigned && e.taskId === i.task.id) {
      rows.push({
        kind: "task_assigned",
        taskId: e.taskId,
        to: e.to,
        body: taskAssignedBody({
          actor: i.actorLabel,
          key: i.task.key,
          title: after.title,
          creator: i.task.creatorLabel,
          body: after.body,
          bodyAuthor: i.task.bodyAuthorLabel,
          deps: i.task.deps,
          blockedBy: i.task.blockedBy,
          links: i.task.links,
        }),
        wake: "task_message",
      });
      continue;
    }
    if (!e.lines.length) continue;
    const notice = PRECEDENCE.find((n) => e.notices.includes(n)) as TaskNotice;
    rows.push({
      kind: "task_update",
      taskId: e.taskId,
      to: e.to,
      notice,
      body: taskUpdateBody(e.lines, e.key, e.title, e.editedBody),
      ...(e.inboxKind ? { inboxKind: e.inboxKind } : {}),
      wake: "task_message",
    });
  }

  if (i.comment) rows.push(...commentRows(i, i.comment));
  return rows;
}

const isHumanActor = (i: PlanInput, id: string) => i.actor.kind === "human" && i.actor.id === id;

function statusLine(e: Entry, i: PlanInput, to: TaskStatus) {
  const line: UpdateLine =
    to === "done" || to === "cancelled"
      ? { k: to, actor: i.actorLabel }
      : { k: "status", actor: i.actorLabel, to };
  const notice: TaskNotice = to === "done" || to === "cancelled" ? to : "status_changed";
  if (!e.lines.some((l) => JSON.stringify(l) === JSON.stringify(line))) e.lines.push(line);
  if (!e.notices.includes(notice)) e.notices.push(notice);
}

function commentRows(i: PlanInput, c: NonNullable<PlanInput["comment"]>): PlannedRow[] {
  const from: Who = { kind: i.actor.kind, id: i.actor.id };
  const rows: PlannedRow[] = [];
  const agents: string[] = [];
  for (const id of [i.after.assigneeId, ...c.mentionedAgentIds]) {
    if (!id || agents.includes(id)) continue;
    if (i.actor.kind === "agent" && i.actor.id === id) continue;
    if (!i.live.has(id)) continue;
    agents.push(id);
  }
  for (const agentId of agents) {
    rows.push({
      kind: "task_comment",
      taskId: i.task.id,
      to: { kind: "agent", id: agentId },
      commentId: c.id,
      from,
      body: c.body,
      wake: i.actor.kind === "human" ? "human" : "task_message",
    });
  }
  for (const userId of c.mentionedUserIds) {
    if (isHumanActor(i, userId)) continue;
    rows.push({
      kind: "task_comment",
      taskId: i.task.id,
      to: { kind: "human", id: userId },
      commentId: c.id,
      from,
      body: c.body,
      inboxKind: "mention",
      wake: "task_message",
    });
  }
  return rows;
}
