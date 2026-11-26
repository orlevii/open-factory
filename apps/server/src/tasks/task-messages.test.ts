import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { Router } from "../messaging/router.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let creatorId: string;
let taskId: string;
beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  const { user } = await signUp(h.app, { handle: "or" });
  creatorId = user.id;
  taskId = randomUUID();
  await h.sql`insert into tasks (id, title, created_by_id) values (${taskId}, 'Plan the migration', ${creatorId})`;
  await h.seedAgent({ slug: "dev" });
});
afterEach(() => h.close());

const proc = (slug: string) => driver.starts.filter((p) => p.spec.slug === slug).at(-1);
async function dev() {
  const a = await h.app.store.agentBySlug("dev");
  if (!a) throw new Error("seed");
  return a;
}
const assigned = async () =>
  h.app.store.createTaskMessage(h.db, {
    kind: "task_assigned",
    taskId,
    toAgentId: (await dev()).id,
    body: "@or assigned you T-1",
  });
const update = async () =>
  h.app.store.createTaskMessage(h.db, {
    kind: "task_update",
    taskId,
    notice: "done",
    toAgentId: (await dev()).id,
    body: "@or marked T-1 done.",
  });
/** Hands the row over and waits for the hand-off itself (it is fire-and-forget behind the boot gate), then for the runtime. */
async function handOff(
  row: Parameters<Router["handOffTaskRows"]>[0][number]["row"],
  wake: "human" | "task_message",
) {
  const deliver = vi.spyOn(h.app.runtimes, "deliver");
  try {
    h.app.router.handOffTaskRows([{ row, wake }]);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await deliver.mock.results[0]?.value;
    await (await h.app.runtimes.bySlug("dev"))?.settled();
  } finally {
    deliver.mockRestore();
  }
}
async function startedReasons() {
  const a = await dev();
  return (await h.app.store.after(a.id, 0, 100))
    .map((e) => e.event)
    .filter((e) => e.type === "process_started")
    .map((e) => (e as { reason?: string }).reason);
}

test("a task_assigned row hands off without throwing, wakes a hibernated agent with task_message and carries its task", async () => {
  const row = await assigned();
  expect(row.taskNumber).toBe(1);
  await handOff(row, "task_message");
  expect(proc("dev")?.sent[0]?.[0]).toMatchObject({
    from: "@factory",
    kind: "task_assigned",
    taskKey: "T-1",
    taskTitle: "Plan the migration",
  });
  expect(await startedReasons()).toContain("task_message");
});

test("a task_update hands off the same way and its notice is the envelope's fact", async () => {
  const row = await update();
  await handOff(row, "task_message");
  expect(proc("dev")?.sent[0]?.[0]).toMatchObject({
    kind: "task_update",
    fact: "done",
    taskKey: "T-1",
  });
});

async function makeErrored() {
  const a = await dev();
  await h.sql`update agents set status = 'errored', last_error = 'boom', error_kind = 'crashed' where id = ${a.id}`;
}

test("to an errored agent a task_message stays pending and starts no attempt", async () => {
  await makeErrored();
  const row = await update();
  await handOff(row, "task_message");
  const [a] = await h.sql`select status, attempting from agents where slug = 'dev'`;
  expect(a).toEqual({ status: "errored", attempting: false });
  expect(driver.starts.filter((p) => p.spec.slug === "dev")).toHaveLength(0);
  expect((await h.sql`select state from messages where id = ${row.id}`)[0]?.state).toBe("pending");
});

test("a human's task comment to an errored agent starts an attempt with the message reason", async () => {
  await makeErrored();
  const a = await dev();
  const commentId = randomUUID();
  await h.sql`insert into task_comments (id, task_id, author_id, body) values (${commentId}, ${taskId}, ${creatorId}, '@dev look')`;
  const row = await h.app.store.createTaskMessage(h.db, {
    kind: "task_comment",
    taskId,
    commentId,
    from: { userId: creatorId },
    toAgentId: a.id,
    body: "@dev look",
  });
  await handOff(row, "human");
  expect(proc("dev")).toBeDefined();
  expect(await startedReasons()).toContain("message");
  proc("dev")?.emit(...ev.fullTurn("sess-dev"));
  expect(proc("dev")?.sent[0]?.[0]).toMatchObject({
    from: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/),
    kind: "task_comment",
    commentId,
  });
});

test("boot wakes an agent whose only pending row is a task row", async () => {
  await update();
  const wakes = await h.app.store.bootWakes();
  expect(wakes.map((w) => w.slug)).toEqual(["dev"]);
});

test("createHumanMessage: a task_update to a user is a task_event inbox item", async () => {
  const { row, userIds } = await h.app.store.createHumanMessage({
    kind: "task_update",
    taskId,
    notice: "done",
    to: { userId: creatorId },
    inboxKind: "task_event",
    body: "@dev marked T-1 done.",
    urgent: false,
  });
  expect(row?.state).toBe("delivered");
  expect(userIds).toEqual([creatorId]);
  const items = await h.sql`select kind from inbox_items where message_id = ${row?.id as string}`;
  expect(items.map((i) => i.kind)).toEqual(["task_event"]);
});

test("createHumanMessage: `all` is for factory facts only; a comment can't address every human", async () => {
  await signUp(h.app, { handle: "sam" });
  const commentId = randomUUID();
  await h.sql`insert into task_comments (id, task_id, author_id, body) values (${commentId}, ${taskId}, ${creatorId}, 'hi')`;
  await expect(
    h.app.store.createHumanMessage({
      kind: "task_comment",
      taskId,
      commentId,
      fromUserId: creatorId,
      to: "all",
      inboxKind: "mention",
      body: "hi",
      urgent: false,
    }),
  ).rejects.toThrow("only a factory fact goes to every human");
  expect(await h.sql`select id from messages where comment_id = ${commentId}`).toEqual([]);
});

test("createHumanMessage per kind: a task_update has no sender; a comment needs exactly one author", async () => {
  await expect(
    h.app.store.createHumanMessage({
      kind: "task_update",
      taskId,
      notice: "done",
      fromUserId: creatorId,
      to: { userId: creatorId },
      body: "x",
      urgent: false,
    }),
  ).rejects.toThrow(/no sender/);
  await expect(
    h.app.store.createHumanMessage({
      kind: "task_comment",
      taskId,
      to: { userId: creatorId },
      body: "x",
      urgent: false,
    }),
  ).rejects.toThrow(/exactly one author/);
});

test("handOffTaskRows waits for bootDone, does nothing after close, and a rejecting deliver is logged, never unhandled", async () => {
  const row = await update();
  const deliver = vi.fn().mockRejectedValue(new Error("start failed"));
  const info = vi.fn();
  const router = new Router({
    db: h.db,
    store: h.app.store,
    runtimes: { deliver } as never,
    bus: h.app.bus,
    log: { info } as never,
    neighborhood: h.app.neighborhood,
    loopGuard: {} as never, // these tests never send as an agent
  });
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    router.handOffTaskRows([{ row, wake: "task_message" }]);
    await new Promise((r) => setImmediate(r));
    expect(deliver).not.toHaveBeenCalled();
    router.bootDone();
    await vi.waitFor(() => expect(info).toHaveBeenCalled());
    expect(deliver).toHaveBeenCalledWith(row, "agent", "task_message");
    expect(unhandled).not.toHaveBeenCalled();
    router.close();
    router.handOffTaskRows([{ row, wake: "human" }]);
    await new Promise((r) => setImmediate(r));
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
