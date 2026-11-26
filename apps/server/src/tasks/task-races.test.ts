import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { seedTestUser, testRef } from "../test/principals.ts";
import type { TaskError } from "./errors.ts";
import type { Actor } from "./permission.ts";
import { CONFLICT_SENTENCE } from "./task-service.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Actor;
const ids: Record<string, string> = {};
const agent = (slug: string): Actor => ({
  kind: "agent",
  id: ids[slug] as string,
  ref: testRef(ids[slug] as string),
  handle: slug,
});

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  const u = await signUp(h.app, { handle: "or" });
  or = { kind: "human", id: u.user.id, ref: testRef(u.user.id), handle: "or" };
  for (const slug of ["lead", "dev", "qa"]) ids[slug] = (await h.seedAgent({ slug })).id;
  await h.sql`update agents set reports_to = ${ids.lead as string} where slug = 'dev'`;
});
afterEach(() => h.close());

/** Polls `pg_stat_activity` until `n` backends of this database wait on a lock (no sleeps, no timeouts of ours). */
async function waitForLocks(n = 1): Promise<void> {
  for (;;) {
    const r =
      await h.sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if (r.length >= n) return;
    await new Promise((res) => setImmediate(res));
  }
}
/** Holds a transaction open on its own connection until `release()`. */
function hold(run: (tx: typeof h.sql) => Promise<void>) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isReady = new Promise<void>((r) => (ready = r));
  const done = h.sql.begin(async (tx) => {
    await run(tx as unknown as typeof h.sql);
    ready();
    await gate;
  });
  return { ready: isReady, release, done };
}
const outcome = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
const spawned = async (slug: string) => {
  const a = await h.seedAgent({ slug });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string} where id = ${a.id}`;
  ids[slug] = a.id;
  return a.id;
};
const kinds = (slug: string) =>
  h.sql`select m.kind, m.notice, m.state from messages m join agents a on a.id = m.to_id
    where a.slug = ${slug} and m.task_id is not null order by m.created_at`;

test("termination first: the assignment is refused", async () => {
  const kid = await spawned("kid");
  const a = hold(async (tx) => {
    await tx`select id from agents where id = ${kid} for no key update`;
    await tx`update agents set terminated_at = now(), terminated_by = null where id = ${kid}`;
  });
  await a.ready;
  const create = outcome(h.app.tasks.create(or, { title: "t", assignee: "kid" }));
  await waitForLocks();
  a.release();
  await a.done;
  const r = await create;
  expect(r.ok).toBe(false);
  expect((r as { e: TaskError }).e.message).toBe(
    "@kid was terminated and can't be assigned tasks.",
  );
  expect((await h.sql`select count(*)::int as n from tasks`)[0]?.n).toBe(0);
});

test("assignment first: the termination waits, then rejects the pending task_assigned; the task keeps the ended assignee", async () => {
  const kid = await spawned("kid");
  const a = hold(async (tx) => {
    await tx`lock table messages in share mode`;
  });
  await a.ready;
  const create = outcome(h.app.tasks.create(or, { title: "t", assignee: "kid" }));
  await waitForLocks(1);
  const term = outcome(h.app.terminator.terminate(kid, await seedTestUser(h.app.db, "or")));
  await waitForLocks(2);
  a.release();
  await a.done;
  expect((await create).ok).toBe(true);
  expect((await term).ok).toBe(true);
  expect(await kinds("kid")).toMatchObject([{ kind: "task_assigned", state: "rejected" }]);
  const [t] = await h.sql`select assignee_agent_id from tasks`;
  expect(t?.assignee_agent_id).toBe(kid);
});

test("archive vs a comment mentioning the archived agent, both orders", async () => {
  await h.app.tasks.create(or, { title: "t" });
  // Archive first.
  await h.sql`update agents set archived_at = now() where slug = 'qa'`;
  const first = await h.app.tasks.comment(or, "T-1", `<@${testRef(ids.qa as string)}> hello`);
  expect(first.notReached).toEqual([{ name: "qa", reason: "archived" }]);
  await h.sql`update agents set archived_at = null where slug = 'qa'`;
  // Comment first: the archive (an agent-row write) waits for our FOR SHARE, then the row is rejected at hand-off.
  const a = hold(async (tx) => {
    await tx`lock table messages in share mode`;
  });
  await a.ready;
  const comment = outcome(h.app.tasks.comment(or, "T-1", `<@${testRef(ids.qa as string)}> again`));
  await waitForLocks(1);
  const archive = outcome(h.app.agents.archive("qa", { kind: "human", handle: "or" }));
  await waitForLocks(2);
  a.release();
  await a.done;
  const c = await comment;
  expect(c.ok).toBe(true);
  expect(((await archive) as { ok: boolean }).ok).toBe(true);
  await (await h.app.runtimes.bySlug("qa"))?.settled();
  // The hand-off races the archive's commit, so the row is rejected or still pending (delivered after an unarchive);
  // what can never happen is a write into the archived agent's session.
  expect((await kinds("qa")).map((k) => k.state)).not.toContain("delivered");
  // And a row handed over after the archive is rejected, as S6 does for an archived recipient.
  const row = await h.app.store.createTaskMessage(h.db, {
    kind: "task_update",
    taskId: (await h.sql`select id from tasks`)[0]?.id as string,
    notice: "done",
    toAgentId: ids.qa as string,
    body: "late",
  });
  h.app.router.handOffTaskRows([{ row, wake: "task_message" }]);
  await vi.waitFor(async () => {
    expect((await h.sql`select state from messages where id = ${row.id}`)[0]?.state).toBe(
      "rejected",
    );
  });
});

async function chain() {
  // X = T-1; Y1 = T-2 depends on X and Y2 (T-3); Y2 depends on X. Y1 and Y2 are assigned to different agents.
  await h.app.tasks.create(or, { title: "X" });
  await h.app.tasks.create(or, { title: "Y2", assignee: "qa", dependsOn: ["T-1"] });
  await h.app.tasks.create(or, { title: "Y1", assignee: "dev", dependsOn: ["T-1", "T-2"] });
}

test("the review's deadlock shape: X and Y2 marked done together complete, Y1's assignee hears exactly one unblocked", async () => {
  await chain();
  const [x, y2] = await Promise.all([
    outcome(h.app.tasks.update(or, "T-1", { status: "done" })),
    outcome(h.app.tasks.update(or, "T-2", { status: "done" })),
  ]);
  expect(x.ok).toBe(true);
  expect(y2.ok).toBe(true);
  const unblocked = (await kinds("dev")).filter((k) => k.notice === "unblocked");
  expect(unblocked).toHaveLength(1);
});

test("two dependencies finishing together notify the dependent's assignee exactly once", async () => {
  await h.app.tasks.create(or, { title: "A" });
  await h.app.tasks.create(or, { title: "B" });
  await h.app.tasks.create(or, { title: "C", assignee: "dev", dependsOn: ["T-1", "T-2"] });
  const rs = await Promise.all([
    outcome(h.app.tasks.update(or, "T-1", { status: "done" })),
    outcome(h.app.tasks.update(or, "T-2", { status: "done" })),
  ]);
  expect(rs.every((r) => r.ok)).toBe(true);
  expect((await kinds("dev")).filter((k) => k.notice === "unblocked")).toHaveLength(1);
});

test("an edge added while its dependency is marked done: never blocked by a done task, at most one unblocked", async () => {
  await h.app.tasks.create(or, { title: "dep" });
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const rs = await Promise.all([
    outcome(h.app.tasks.update(or, "T-2", { dependsOn: ["T-1"] })),
    outcome(h.app.tasks.update(or, "T-1", { status: "done" })),
  ]);
  expect(rs.every((r) => r.ok)).toBe(true);
  const detail = await h.app.tasks.detail("T-2", { comments: "all" });
  expect(detail.blockedBy).toEqual([]);
  expect((await kinds("dev")).filter((k) => k.notice === "unblocked").length).toBeLessThanOrEqual(
    1,
  );
});

test("concurrent dependency edits that would form a cycle: exactly one is refused", async () => {
  await h.app.tasks.create(or, { title: "a" });
  await h.app.tasks.create(or, { title: "b" });
  const rs = await Promise.all([
    outcome(h.app.tasks.update(or, "T-1", { dependsOn: ["T-2"] })),
    outcome(h.app.tasks.update(or, "T-2", { dependsOn: ["T-1"] })),
  ]);
  const failed = rs.filter((r) => !r.ok);
  expect(failed).toHaveLength(1);
  expect((failed[0] as { e: TaskError }).e.message).toMatch(/that would make a cycle\.$/);
});

test("an assignee's change racing its reassignment is re-checked under the lock and refused", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const a = hold(async (tx) => {
    await tx`lock table messages in share mode`;
  });
  await a.ready;
  const reassign = outcome(h.app.tasks.update(or, "T-1", { assignee: "qa" }));
  await waitForLocks(1);
  // dev is no manager of anyone and not the creator: once the reassignment commits it may no longer change T-1.
  const change = outcome(h.app.tasks.update(agent("dev"), "T-1", { status: "in_progress" }));
  await waitForLocks(2);
  a.release();
  await a.done;
  expect((await reassign).ok).toBe(true);
  const c = await change;
  expect(c.ok).toBe(false);
  expect((c as { e: TaskError }).e).toMatchObject({ code: "task_forbidden" });
});

test("a comment racing a reassignment goes to the assignee read under the lock", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  const a = hold(async (tx) => {
    await tx`lock table messages in share mode`;
  });
  await a.ready;
  const reassign = outcome(h.app.tasks.update(or, "T-1", { assignee: "qa" }));
  await waitForLocks(1);
  const comment = outcome(h.app.tasks.comment(or, "T-1", "status?"));
  await waitForLocks(2);
  a.release();
  await a.done;
  expect((await reassign).ok).toBe(true);
  const c = await comment;
  expect(c.ok).toBe(true);
  expect((c as { v: { deliveredTo: string[] } }).v.deliveredTo).toEqual(["qa"]);
});

test("a deadlock is retried once; two in a row become a plain sentence, never a raw error", async () => {
  await h.app.tasks.create(or, { title: "t" });
  const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const real = h.db.transaction.bind(h.db);
  let throwTimes = 1;
  const spy = vi.spyOn(h.db, "transaction").mockImplementation(((fn: never, cfg: never) => {
    if (throwTimes > 0) {
      throwTimes--;
      return Promise.reject(deadlock());
    }
    return real(fn, cfg);
  }) as never);
  const ok = await h.app.tasks.update(or, "T-1", { title: "retried" });
  expect(ok.task.title).toBe("retried");
  throwTimes = 2;
  const e = await outcome(h.app.tasks.update(or, "T-1", { title: "again" }));
  expect(e.ok).toBe(false);
  expect((e as { e: TaskError }).e).toMatchObject({
    code: "task_conflict",
    status: 409,
    message: CONFLICT_SENTENCE,
  });
  spy.mockRestore();
});
