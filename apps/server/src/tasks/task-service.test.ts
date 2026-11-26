import type { ServerMessage } from "@open-factory/shared";
import { tagOf } from "@open-factory/shared/tags";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";
import { TaskError } from "./errors.ts";
import type { Actor } from "./permission.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let or: Actor;
let sam: Actor;
/** Who the `or` human is, as the task messages name it: its tag. */
let OR = "";
const ids: Record<string, string> = {};
const frames: ServerMessage[] = [];
const agent = (slug: string): Actor => ({
  kind: "agent",
  id: ids[slug] as string,
  ref: testRef(ids[slug] as string),
  handle: slug,
});

beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  frames.length = 0;
  h.app.bus.subscribeAll((m) => frames.push(m));
  const u1 = await signUp(h.app, { handle: "or" });
  const u2 = await signUp(h.app, { handle: "sam" });
  or = { kind: "human", id: u1.user.id, ref: testRef(u1.user.id), handle: "or" };
  sam = { kind: "human", id: u2.user.id, ref: testRef(u2.user.id), handle: "sam" };
  ids.or = u1.user.id;
  OR = tagOf(or.ref);
  ids.sam = u2.user.id;
  h.app.bus.subscribeUser(u2.user.id, (m) => frames.push(m));
  for (const slug of ["lead", "dev", "qa"]) ids[slug] = (await h.seedAgent({ slug })).id;
  await h.sql`update agents set reports_to = ${ids.lead as string} where slug = 'dev'`;
});
afterEach(() => h.close());

const settle = async (...slugs: string[]) => {
  for (const s of slugs) await (await h.app.runtimes.bySlug(s))?.settled();
};
const proc = (slug: string) => driver.starts.filter((p) => p.spec.slug === slug).at(-1);
const sentTo = (slug: string) => (proc(slug)?.sent ?? []).flat();
const rowsTo = (slug: string) =>
  h.sql`select m.kind, m.notice, m.body, m.state from messages m join agents a on a.id = m.to_id
    where a.slug = ${slug} and m.task_id is not null order by m.created_at`;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaskError) return e;
    throw e;
  }
  throw new Error("expected a TaskError");
};

test("create assigned to a hibernated agent wakes it with the brief (AC 1)", async () => {
  const r = await h.app.tasks.create(or, {
    title: "Plan the migration",
    body: "Line one\nLine two",
    assignee: "dev",
  });
  expect(r.task).toMatchObject({ key: "T-1", status: "open", assignee: "dev", blockedBy: [] });
  await settle("dev");
  const env = sentTo("dev");
  expect(env).toHaveLength(1);
  expect(env[0]).toMatchObject({ from: "@factory", kind: "task_assigned", taskKey: "T-1" });
  expect(env[0]?.body).toContain(`${OR} assigned you T-1, created by ${OR}: "Plan the migration"`);
  expect(env[0]?.body).toContain(`The task, written by ${OR}:\n> Line one\n> Line two`);
  expect(frames).toContainEqual({ type: "tasks_changed", keys: ["T-1"] });
  const ev = await h.sql`select type from task_events order by at`;
  expect(ev.map((e) => e.type)).toEqual(["created", "assignee"]);
});

test("dependencies: blocked_by, unknown, self and cycle", async () => {
  await h.app.tasks.create(or, { title: "one" });
  const two = await h.app.tasks.create(or, { title: "two", dependsOn: ["T-1"] });
  expect(two.task.blockedBy).toEqual(["T-1"]);
  expect(
    await fails(h.app.tasks.create(or, { title: "x", dependsOn: ["T-1", "T-99"] })),
  ).toMatchObject({
    message: "No task T-99.",
    field: "dependsOn",
  });
  expect((await fails(h.app.tasks.update(or, "T-2", { dependsOn: ["T-2"] }))).message).toBe(
    "A task can't depend on itself.",
  );
  const cyc = await fails(h.app.tasks.update(or, "T-1", { dependsOn: ["T-2"] }));
  expect(cyc).toMatchObject({
    message: "T-2 already depends on T-1; that would make a cycle.",
    field: "dependsOn",
    status: 400,
  });
  await h.app.tasks.create(or, { title: "three", dependsOn: ["T-2"] });
  expect((await fails(h.app.tasks.update(or, "T-1", { dependsOn: ["T-3"] }))).message).toBe(
    "T-3 already depends on T-1 (through T-2); that would make a cycle.",
  );
});

test("links are validated; an agent link needs an existing agent", async () => {
  expect(
    await fails(
      h.app.tasks.create(or, {
        title: "x",
        links: [{ kind: "url", target: "javascript:alert(1)" }],
      }),
    ),
  ).toMatchObject({ message: "Links must be http(s) URLs.", field: "links", status: 400 });
  expect(
    (
      await fails(
        h.app.tasks.create(or, { title: "x", links: [{ kind: "agent", target: "nobody" }] }),
      )
    ).message,
  ).toBe("No agent @nobody.");
  const ok = await h.app.tasks.create(or, {
    title: "x",
    links: [
      { kind: "pr", target: "https://github.com/a/b/pull/1", title: "PR" },
      { kind: "agent", target: "@qa" },
    ],
  });
  expect(ok.task.key).toBe("T-1");
});

test("who may change: an unrelated agent is refused with who can, a manager is allowed", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const e = await fails(h.app.tasks.update(agent("qa"), "T-1", { status: "done" }));
  expect(e).toMatchObject({ code: "task_forbidden", status: 403 });
  expect(e.message).toBe(
    "Only T-1's creator (@or), its assignee (@dev) or their managers can change it; comment on it instead.",
  );
  expect(
    (await h.app.tasks.update(agent("lead"), "T-1", { status: "in_progress" })).changed,
  ).toEqual(["status"]);
  expect((await h.app.tasks.update(agent("dev"), "T-1", { title: "renamed" })).changed).toEqual([
    "title",
  ]);
  expect((await fails(h.app.tasks.update(or, "T-9", { status: "done" }))).code).toBe(
    "task_not_found",
  );
});

test("done tells the creator and unblocks the dependent's assignee; nobody is told of their own act (AC 3)", async () => {
  await h.app.tasks.create(agent("lead"), { title: "first", assignee: "dev" });
  await h.app.tasks.create(or, { title: "second", assignee: "qa", dependsOn: ["T-1"] });
  await settle("dev", "qa");
  const r = await h.app.tasks.update(agent("dev"), "T-1", { status: "done" });
  expect(r.changed).toEqual(["status"]);
  await settle("lead", "qa", "dev");
  expect(await rowsTo("lead")).toMatchObject([
    {
      kind: "task_update",
      notice: "done",
      body: `${tagOf(testRef(ids.dev as string))} marked T-1 done.`,
    },
  ]);
  const qa = (await rowsTo("qa")).filter((x) => x.kind === "task_update");
  expect(qa).toMatchObject([{ notice: "unblocked" }]);
  expect(qa[0]?.body).toBe(`T-2 "second" is no longer blocked: T-1 is done.`);
  expect((await rowsTo("dev")).map((x) => x.kind)).toEqual(["task_assigned"]);
  expect(frames).toContainEqual({ type: "tasks_changed", keys: ["T-1", "T-2"] });
});

test("one update changing status and body sends the assignee one message listing both", async () => {
  await h.app.tasks.create(agent("lead"), { title: "t", body: "old", assignee: "dev" });
  await settle("dev");
  await h.app.tasks.update(or, "T-1", { status: "in_progress", body: "new brief" });
  const rows = (await rowsTo("dev")).filter((x) => x.kind === "task_update");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.notice).toBe("status_changed");
  expect(rows[0]?.body).toBe(
    `${OR} moved T-1 to in progress.\n${OR} edited T-1's description:\n> new brief`,
  );
});

test("reassigning tells the new assignee and the old one", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const r = await h.app.tasks.update(agent("lead"), "T-1", { assignee: "qa" });
  expect(r.task.assignee).toBe("qa");
  expect((await rowsTo("qa")).map((x) => x.kind)).toEqual(["task_assigned"]);
  expect((await rowsTo("dev")).map((x) => [x.kind, x.notice])).toEqual([
    ["task_assigned", null],
    ["task_update", "unassigned"],
  ]);
  const un = await h.app.tasks.update(or, "T-1", { assignee: null });
  expect(un.task.assignee).toBeUndefined();
});

test("assignee rules: ended, human, unknown, me", async () => {
  await h.sql`update agents set archived_at = now() where slug = 'qa'`;
  expect((await fails(h.app.tasks.create(or, { title: "t", assignee: "qa" }))).message).toBe(
    "@qa was archived and can't be assigned tasks.",
  );
  expect((await fails(h.app.tasks.create(or, { title: "t", assignee: "@or" }))).message).toBe(
    "Tasks can only be assigned to agents; @or is a human.",
  );
  expect((await fails(h.app.tasks.create(or, { title: "t", assignee: "me" }))).code).toBe(
    "reserved",
  );
  const spawned = await h.seedAgent({ slug: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string}, terminated_at = now(), terminated_by = null where id = ${spawned.id}`;
  expect((await fails(h.app.tasks.create(or, { title: "t", assignee: "kid" }))).message).toBe(
    "@kid was terminated and can't be assigned tasks.",
  );
  const mine = await h.app.tasks.create(agent("dev"), { title: "mine", assignee: "me" });
  expect(mine.task.assignee).toBe("dev");
  expect(await rowsTo("dev")).toEqual([]);
  expect((await fails(h.app.tasks.update(or, "T-1", { assignee: "nobody" }))).code).toBe(
    "not_found",
  );
});

test("a no-op patch writes no history and sends nothing", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const before = (await h.sql`select count(*)::int as n from task_events`)[0]?.n;
  const r = await h.app.tasks.update(or, "T-1", { status: "open", title: "t", assignee: "dev" });
  expect(r.changed).toEqual([]);
  expect((await h.sql`select count(*)::int as n from task_events`)[0]?.n).toBe(before);
  expect(await rowsTo("dev")).toHaveLength(1);
});

test("a human creator hears about done as an inbox task_event, the actor does not", async () => {
  await h.app.tasks.create(sam, { title: "t", assignee: "dev" });
  await h.app.tasks.update(or, "T-1", { status: "done" });
  const items =
    await h.sql`select i.user_id, i.kind from inbox_items i join messages m on m.id = i.message_id where m.task_id is not null`;
  expect(items).toEqual([{ user_id: ids.sam, kind: "task_event" }]);
  expect(frames).toContainEqual({ type: "inbox_changed" });
  const done =
    await h.sql`select notice, to_id, state from messages where kind = 'task_update' and to_id in (select id from users)`;
  expect(done).toEqual([{ notice: "done", to_id: ids.sam, state: "delivered" }]);
});

test("removing the last blocking dependency unblocks the task's assignee", async () => {
  await h.app.tasks.create(or, { title: "a" });
  await h.app.tasks.create(or, { title: "b", assignee: "qa", dependsOn: ["T-1"] });
  await settle("qa");
  await h.app.tasks.update(or, "T-2", { dependsOn: [] });
  const rows = (await rowsTo("qa")).filter((x) => x.kind === "task_update");
  expect(rows.map((x) => x.body)).toEqual([
    `T-2 "b" is no longer blocked: T-1 was removed from its dependencies.`,
  ]);
});

test("a task_update to an errored assignee carries the errored note", async () => {
  await h.sql`update agents set status = 'errored', last_error = 'boom', error_kind = 'crashed' where slug = 'dev'`;
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const r = await h.app.tasks.update(or, "T-1", { status: "in_progress" });
  expect(r.note).toBe(
    "@dev is errored; it will see this after it is restarted (restart_agent, or a human).",
  );
});

test("removing the last blocker unblocks even when the other blocker's completion commits while the edit waits on the lock", async () => {
  await h.app.tasks.create(or, { title: "X" });
  await h.app.tasks.create(or, { title: "Y" });
  await h.app.tasks.create(or, { title: "D", assignee: "dev", dependsOn: ["T-1", "T-2"] });
  await settle("dev");
  const before = (await rowsTo("dev")).length;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const holder = h.sql.begin(async (tx) => {
    await tx`update tasks set status = 'done', updated_at = now() where number = 1`;
    ready();
    await gate;
  });
  await isReady;
  // D's edit keeps only X and waits on X's row lock; X is done (and Y still blocks) once it gets through.
  const edit = h.app.tasks.update(or, "T-3", { dependsOn: ["T-1"] });
  for (;;) {
    const r =
      await h.sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if (r.length) break;
    await new Promise((res) => setImmediate(res));
  }
  release();
  await holder;
  await edit;
  const rows = (await rowsTo("dev")).slice(before);
  expect(rows.map((x) => x.notice)).toEqual(["unblocked"]);
});

test("a create with no dependencies does not take the dependency graph lock; one with dependencies does", async () => {
  const { TASK_GRAPH_LOCK } = await import("./task-store.ts");
  const reserved = await h.sql.reserve();
  await reserved`select pg_advisory_lock(${TASK_GRAPH_LOCK})`;
  try {
    const plain = await h.app.tasks.create(or, { title: "plain" });
    expect(plain.task.key).toBe("T-1");
    const withDeps = h.app.tasks.create(or, { title: "dep", dependsOn: ["T-1"] });
    const first = await Promise.race([
      withDeps.then(() => "done"),
      new Promise((r) => setTimeout(() => r("waiting"), 300)),
    ]);
    expect(first).toBe("waiting");
  } finally {
    await reserved`select pg_advisory_unlock(${TASK_GRAPH_LOCK})`;
    reserved.release();
  }
});
