import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";
import type { Actor } from "./permission.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let or: Actor;
const ids: Record<string, string> = {};
const agent = (slug: string): Actor => ({
  kind: "agent",
  id: ids[slug] as string,
  ref: testRef(ids[slug] as string),
  handle: slug,
});

beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  const u = await signUp(h.app, { handle: "or" });
  or = { kind: "human", id: u.user.id, ref: testRef(u.user.id), handle: "or" };
  for (const slug of ["lead", "dev", "qa"]) ids[slug] = (await h.seedAgent({ slug })).id;
  await h.sql`update agents set reports_to = ${ids.lead as string} where slug = 'dev'`;
});
afterEach(() => h.close());

const settle = async (...slugs: string[]) => {
  for (const s of slugs) await (await h.app.runtimes.bySlug(s))?.settled();
};
const procs = (slug: string) => driver.startsOf(slug);
const proc = (slug: string) => procs(slug).at(-1);
const reasons = async (slug: string) => {
  const a = await h.app.store.agentBySlug(slug);
  return (await h.app.store.after(a?.id ?? "", 0, 200))
    .map((e) => e.event)
    .flatMap((e) => (e.type === "process_started" ? [e.reason] : []));
};
const rows = (slug: string) =>
  h.sql`select m.id, m.kind, m.notice, m.state from messages m join agents a on a.id = m.to_id
    where a.slug = ${slug} and m.task_id is not null order by m.created_at`;
const makeErrored = (slug = "dev") =>
  h.sql`update agents set status = 'errored', last_error = 'boom', error_kind = 'crashed' where slug = ${slug}`;
const messageIns = async (slug: string) => {
  const a = await h.app.store.agentBySlug(slug);
  return (await h.app.store.after(a?.id ?? "", 0, 500)).flatMap((e) =>
    e.event.type === "message_in" ? e.event.messages : [],
  );
};

test("an errored assignee: the row stays pending with the note; a human comment starts an attempt, an agent's doesn't", async () => {
  await makeErrored();
  const r = await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  expect(r.note).toBe(
    "@dev is errored; it will see this after it is restarted (restart_agent, or a human).",
  );
  await settle("dev");
  expect(procs("dev")).toHaveLength(0);
  expect((await rows("dev"))[0]?.state).toBe("pending");
  await h.app.tasks.comment(agent("qa"), "T-1", "@dev any news?");
  await settle("dev");
  expect(procs("dev")).toHaveLength(0);
  expect((await h.sql`select attempting from agents where slug = 'dev'`)[0]?.attempting).toBe(
    false,
  );
  await h.app.tasks.comment(or, "T-1", "@dev please restart");
  await settle("dev");
  expect(await reasons("dev")).toContain("message");
  expect(procs("dev")).toHaveLength(1);
});

test("a warm idle assignee gets the row at once; a busy one gets it mid-turn", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  await settle("dev");
  const p = proc("dev");
  p?.emit(...ev.fullTurn("sess-dev"));
  await settle("dev");
  expect(p?.sent).toHaveLength(1);
  await h.app.tasks.update(or, "T-1", { status: "in_progress" });
  await settle("dev");
  expect(procs("dev")).toHaveLength(1);
  expect(p?.sent).toHaveLength(2);
  expect(p?.sent[1]?.[0]).toMatchObject({ kind: "task_update", taskKey: "T-1" });
  // Mid-turn: a turn is open; the next row is written into it.
  p?.emit(ev.turn());
  await settle("dev");
  await h.app.tasks.update(or, "T-1", { title: "renamed" });
  await settle("dev");
  expect(p?.sent).toHaveLength(3);
  expect(p?.sent[2]?.[0]).toMatchObject({ kind: "task_update", fact: "edited" });
});

test("a rate-limited credential: the row waits", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  await settle("dev");
  const p = proc("dev");
  p?.emit(ev.session("sess-dev"), ev.turn());
  await settle("dev");
  p?.emit({
    type: "rate_limited",
    status: "rejected",
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    rateLimitType: "five_hour",
  });
  p?.emit(ev.end({ isError: true, terminalReason: "api_error", apiErrorStatus: 429 }));
  await settle("dev");
  const sentBefore = p?.sent.length;
  await h.app.tasks.update(or, "T-1", { status: "in_progress" });
  await settle("dev");
  expect(p?.sent.length).toBe(sentBefore);
  expect((await h.app.runtimes.bySlug("dev"))?.live().status).toBe("rate_limited");
  expect((await rows("dev")).at(-1)).toMatchObject({ kind: "task_update", state: "pending" });
});

test("a server stop between commit and hand-off: the next boot delivers the row once", async () => {
  const spy = vi.spyOn(h.app.router, "handOffTaskRows").mockImplementation(() => {});
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  spy.mockRestore();
  await settle("dev");
  expect(procs("dev")).toHaveLength(0);
  const id = (await rows("dev"))[0]?.id as string;
  await h.app.close();
  const next = await h.reopen();
  await (await next.app.runtimes.bySlug("dev"))?.settled();
  await vi.waitFor(async () => expect(procs("dev")).toHaveLength(1));
  await (await next.app.runtimes.bySlug("dev"))?.settled();
  const ins = (await messageIns("dev")).filter((m) => m.id === id || m.ids?.includes(id));
  expect(ins).toHaveLength(1);
  procs("dev")
    .at(-1)
    ?.emit(...ev.fullTurn("sess-dev"));
  await (await next.app.runtimes.bySlug("dev"))?.settled();
  expect((await rows("dev"))[0]?.state).toBe("delivered");
});

test("shutdown begun: the change commits, nothing is handed over", async () => {
  h.app.router.close();
  const r = await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  expect(r.task.key).toBe("T-1");
  await settle("dev");
  expect(procs("dev")).toHaveLength(0);
  expect((await rows("dev"))[0]?.state).toBe("pending");
});

test("a terminated caller whose request is already past the listener is refused", async () => {
  const kid = await h.seedAgent({ slug: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string} where id = ${kid.id}`;
  const as: Actor = { kind: "agent", id: kid.id, ref: testRef(kid.id), handle: "kid" };
  await h.app.tasks.create(as, { title: "t" });
  await h.sql`update agents set terminated_at = now(), terminated_by = null where id = ${kid.id}`;
  const sentence = "You can't work on tasks: you were terminated.";
  await expect(h.app.tasks.update(as, "T-1", { status: "done" })).rejects.toMatchObject({
    message: sentence,
  });
  await expect(h.app.tasks.comment(as, "T-1", "hi")).rejects.toMatchObject({ message: sentence });
  await expect(h.app.tasks.create(as, { title: "again" })).rejects.toMatchObject({
    message: sentence,
  });
});

test("a spawner terminating its child: pending task rows are rejected, the task keeps the ended assignee, the spawner may still change it", async () => {
  const kid = await h.seedAgent({ slug: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string} where id = ${kid.id}`;
  const spy = vi.spyOn(h.app.router, "handOffTaskRows").mockImplementation(() => {});
  await h.app.tasks.create(or, { title: "t", assignee: "kid" });
  spy.mockRestore();
  await h.app.terminator.terminate(kid.id, {
    id: ids.lead as string,
    kind: "agent",
    ref: testRef(ids.lead as string),
    handle: "lead",
  });
  expect((await rows("kid")).map((x) => x.state)).toEqual(["rejected"]);
  const t = await h.app.tasks.detail("T-1", { comments: "all" });
  expect(t.assignee).toMatchObject({ slug: "kid", ended: "terminated" });
  const r = await h.app.tasks.update(agent("lead"), "T-1", { status: "in_progress" });
  expect(r.changed).toEqual(["status"]);
  expect(r.task.assigneeEnded).toBe("terminated");
  expect((await rows("kid")).map((x) => x.state)).toEqual(["rejected"]); // nothing written to the ended agent
});

test("unarchive is not retroactive: nothing was written while the agent was archived", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "dev" });
  await settle("dev");
  proc("dev")?.emit(...ev.fullTurn("sess-dev"));
  await settle("dev");
  await h.app.agents.archive("dev", { kind: "human", ref: "k7x2m9qd", handle: "or" });
  const before = (await rows("dev")).length;
  await h.app.tasks.update(or, "T-1", { status: "in_progress" });
  await h.app.tasks.comment(or, "T-1", "@dev hello");
  expect((await rows("dev")).length).toBe(before);
  await h.app.agents.unarchive("dev", { kind: "human", ref: "k7x2m9qd", handle: "or" });
  await settle("dev");
  expect((await rows("dev")).length).toBe(before);
});

test("start a new session with only a task_update queued starts an attempt (S5's rule, accepted)", async () => {
  await h.app.tasks.create(or, { title: "t", assignee: "qa" });
  await settle("qa");
  await h.sql`update agents set status = 'errored', last_error = 'boom', error_kind = 'resume_unrecoverable' where slug = 'dev'`;
  await h.app.tasks.update(or, "T-1", { assignee: "dev" });
  await h.app.tasks.update(or, "T-1", { status: "in_progress" });
  await settle("dev");
  expect(procs("dev")).toHaveLength(0);
  const rt = await h.app.runtimes.bySlug("dev");
  await rt?.resetSession({ by: "<@or>" });
  await settle("dev");
  expect(await reasons("dev")).toContain("reset");
  expect(procs("dev")).toHaveLength(1);
});
