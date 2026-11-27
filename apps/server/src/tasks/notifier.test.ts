import type { TaskStatus } from "@open-factory/shared";
import { expect, test } from "vitest";
import { type PlanInput, type PlannedRow, plan } from "./notifier.ts";
import type { Actor } from "./permission.ts";

const labels: Record<string, string> = { dev: "@dev", qa: "@qa", lead: "@lead" };
const agent = (id: string): Actor => ({ kind: "agent", id, ref: `ref-${id}`, handle: id });
const or: Actor = { kind: "human", id: "or", ref: "ref-or", handle: "or" };
type Snap = { status: TaskStatus; assigneeId: string | null; title: string; body: string };
const snap = (o: Partial<Snap> = {}): Snap => ({
  status: "open",
  assigneeId: "dev",
  title: "Plan",
  body: "brief",
  ...o,
});

function input(o: Partial<PlanInput> & { actor: Actor }): PlanInput {
  return {
    actorLabel: `@${o.actor.handle}`,
    live: new Set(["dev", "qa", "lead"]),
    task: {
      id: "t1",
      key: "T-1",
      title: "Plan",
      body: "brief",
      creator: { kind: "agent", id: "lead" },
      creatorLabel: "@lead",
      bodyAuthorLabel: "@lead",
      deps: [],
      blockedBy: [],
      links: [],
    },
    before: snap(),
    after: snap(),
    label: (id) => labels[id] ?? id,
    unblocked: [],
    ...o,
  };
}
const shape = (rows: PlannedRow[]) =>
  rows.map((r) => [r.kind, r.to.kind === "agent" ? r.to.id : `u:${r.to.id}`, r.notice]);

test("1 create with an assignee", () => {
  const rows = plan(input({ actor: or, before: null }));
  expect(shape(rows)).toEqual([["task_assigned", "dev", undefined]]);
  expect(rows[0]?.body).toContain("@or assigned you T-1, created by @lead");
});
test("2 assigned to the creator itself", () => {
  expect(plan(input({ actor: agent("dev"), before: null }))).toEqual([]);
});
test("3 reassign", () => {
  const rows = plan(input({ actor: agent("lead"), after: snap({ assigneeId: "qa" }) }));
  expect(shape(rows)).toEqual([
    ["task_assigned", "qa", undefined],
    ["task_update", "dev", "unassigned"],
  ]);
});
test("4 status + body: one row, both lines, status_changed beats edited", () => {
  const rows = plan(input({ actor: or, after: snap({ status: "in_progress", body: "new" }) }));
  expect(shape(rows)).toEqual([["task_update", "dev", "status_changed"]]);
  expect(rows[0]?.body).toContain("@or moved T-1 to in progress.");
  expect(rows[0]?.body).toContain("> new");
});
test("5 done by the assignee tells the agent creator only", () => {
  const rows = plan(input({ actor: agent("dev"), after: snap({ status: "done" }) }));
  expect(shape(rows)).toEqual([["task_update", "lead", "done"]]);
});
test("6 done by the human creator tells the assignee", () => {
  const rows = plan(
    input({
      actor: or,
      after: snap({ status: "done" }),
      task: {
        ...input({ actor: or }).task,
        creator: { kind: "human", id: "or" },
        creatorLabel: "@or",
      },
    }),
  );
  expect(shape(rows)).toEqual([["task_update", "dev", "done"]]);
  expect(rows[0]?.body).toBe("@or marked T-1 done.");
});
test("7 done with a human creator: an inbox task_event", () => {
  const rows = plan(
    input({
      actor: agent("dev"),
      after: snap({ status: "done" }),
      task: {
        ...input({ actor: or }).task,
        creator: { kind: "human", id: "u2" },
        creatorLabel: "@sam",
      },
    }),
  );
  expect(shape(rows)).toEqual([["task_update", "u:u2", "done"]]);
  expect(rows[0]?.inboxKind).toBe("task_event");
});
test("8 a done and an unblocked to one agent are two rows", () => {
  const rows = plan(
    input({
      actor: agent("dev"),
      after: snap({ status: "done" }),
      unblocked: [
        { taskId: "t2", key: "T-2", title: "Two", assigneeId: "qa", cause: "T-1", how: "done" },
        { taskId: "t3", key: "T-3", title: "Three", assigneeId: "lead", cause: "T-1", how: "done" },
      ],
    }),
  );
  expect(shape(rows)).toEqual([
    ["task_update", "lead", "done"],
    ["task_update", "qa", "unblocked"],
    ["task_update", "lead", "unblocked"],
  ]);
  expect(rows.map((r) => r.taskId)).toEqual(["t1", "t2", "t3"]);
});
test("9 unblocked: not to the actor, not to an ended agent", () => {
  const u = (assigneeId: string) => ({
    taskId: "t2",
    key: "T-2",
    title: "Two",
    assigneeId,
    cause: "T-1",
    how: "done" as const,
  });
  const none = snap({ assigneeId: null });
  expect(
    plan(input({ actor: agent("qa"), before: none, after: none, unblocked: [u("qa")] })),
  ).toEqual([]);
  expect(
    plan(input({ actor: or, live: new Set(), before: none, after: none, unblocked: [u("qa")] })),
  ).toEqual([]);
});
test("10 an agent's comment: to the mentioned agent and human, not to itself", () => {
  const rows = plan(
    input({
      actor: agent("dev"),
      comment: { id: "k1", body: "@qa @or", mentionedAgentIds: ["qa"], mentionedUserIds: ["or"] },
    }),
  );
  expect(shape(rows)).toEqual([
    ["task_comment", "qa", undefined],
    ["task_comment", "u:or", undefined],
  ]);
  expect(rows[1]?.inboxKind).toBe("mention");
  expect(rows[0]?.wake).toBe("task_message");
});
test("13 the assignee mentioned too gets one row", () => {
  const rows = plan(
    input({
      actor: or,
      comment: { id: "k1", body: "@dev", mentionedAgentIds: ["dev"], mentionedUserIds: [] },
    }),
  );
  expect(rows).toHaveLength(1);
});
test("14 an ended assignee gets nothing", () => {
  expect(
    plan(
      input({
        actor: or,
        live: new Set(["qa"]),
        comment: { id: "k1", body: "x", mentionedAgentIds: [], mentionedUserIds: [] },
      }),
    ),
  ).toEqual([]);
  expect(
    plan(
      input({
        actor: or,
        live: new Set(["qa"]),
        after: snap({ status: "done" }),
        task: { ...input({ actor: or }).task, creator: { kind: "human", id: "or" } },
      }),
    ),
  ).toEqual([]);
});
