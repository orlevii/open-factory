import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { TaskError } from "./errors.ts";
import type { Actor } from "./permission.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let or: Actor;
const ids: Record<string, string> = {};
const agent = (slug: string): Actor => ({ kind: "agent", agentId: ids[slug] as string, slug });

beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  const u1 = await signUp(h.app, { handle: "or" });
  const u2 = await signUp(h.app, { handle: "sam" });
  or = { kind: "user", userId: u1.user.id, handle: "or" };
  ids.or = u1.user.id;
  ids.sam = u2.user.id;
  for (const slug of ["lead", "dev", "qa"]) ids[slug] = (await h.seedAgent({ slug })).id;
  await h.app.tasks.create(or, { title: "Plan", assignee: "dev" });
});
afterEach(() => h.close());

const settle = async (...slugs: string[]) => {
  for (const s of slugs) await (await h.app.runtimes.bySlug(s))?.settled();
};
const proc = (slug: string) => driver.starts.filter((p) => p.spec.slug === slug).at(-1);
const inbox = (userId: string) =>
  h.sql`select i.kind, i.read_at, m.body, m.from_agent_id, m.from_user_id, m.comment_id
    from inbox_items i join messages m on m.id = i.message_id where i.user_id = ${userId} order by i.created_at`;
const taskRowsTo = (slug: string, kind: string) =>
  h.sql`select m.id, m.body, m.from_user_id, m.from_agent_id, m.comment_id, m.state from messages m
    join agents a on a.id = m.to_agent_id where a.slug = ${slug} and m.kind = ${kind}`;

test("AC 2 (server side): an agent mentions a human: one unread mention item, nothing to the author", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "@or can you confirm?");
  expect(r).toMatchObject({ deliveredTo: [], mentionedHumans: ["@or"], notReached: [] });
  const items = await inbox(ids.or as string);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "mention", read_at: null, comment_id: r.id });
  expect(await taskRowsTo("dev", "task_comment")).toHaveLength(0);
  expect(await inbox(ids.sam as string)).toHaveLength(0);
});

test("a human's comment mentioning an agent reaches it as task_comment from the human, waking with message", async () => {
  await settle("dev");
  const r = await h.app.tasks.comment(or, "T-1", "@qa yes, go ahead");
  expect(r.deliveredTo).toEqual(["dev", "qa"]);
  await settle("dev", "qa");
  const sent = proc("qa")?.sent.flat()[0];
  expect(sent).toMatchObject({
    from: "@or",
    kind: "task_comment",
    taskKey: "T-1",
    commentId: r.id,
    body: "@qa yes, go ahead",
  });
  const qa = await h.app.store.agentBySlug("qa");
  const started = (await h.app.store.after(qa?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "message" }),
  );
});

test("an agent's comment to another agent wakes it with task_message", async () => {
  await h.app.tasks.comment(agent("dev"), "T-1", "@qa please review");
  await settle("qa");
  const qa = await h.app.store.agentBySlug("qa");
  const started = (await h.app.store.after(qa?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "task_message" }),
  );
});

test("@humans: every existing user but the author; a later user gets none", async () => {
  await h.app.tasks.comment(agent("dev"), "T-1", "@humans heads up");
  expect(await inbox(ids.or as string)).toHaveLength(1);
  expect(await inbox(ids.sam as string)).toHaveLength(1);
  const late = await signUp(h.app, { handle: "late" });
  expect(await inbox(late.user.id)).toHaveLength(0);
  const r = await h.app.tasks.comment(or, "T-1", "@humans and me");
  expect(r.mentionedHumans).toEqual(["@humans"]);
  expect(await inbox(ids.or as string)).toHaveLength(1);
  expect(await inbox(ids.sam as string)).toHaveLength(2);
  expect(await inbox(late.user.id)).toHaveLength(1);
});

test("a user mentioned alongside @humans gets one item", async () => {
  await h.app.tasks.comment(agent("dev"), "T-1", "@sam @humans");
  expect(await inbox(ids.sam as string)).toHaveLength(1);
});

test("mentions in code create nothing", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "`@or` and\n```\n@sam\n```");
  expect(r).toMatchObject({ mentionedHumans: [], notReached: [] });
  expect(await inbox(ids.or as string)).toHaveLength(0);
  expect(await inbox(ids.sam as string)).toHaveLength(0);
});

test("not_reached: unknown, ambiguous, reserved, terminated and archived, in order", async () => {
  await claimTestHandleSql(h.sql, "twin", "user");
  await h.sql`insert into users (id,name,email,handle) values ('twin-u','Twin','twin@x.io','twin')`;
  await h.sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id)
    select 'twin-a','twin','Twin','t','{}','local',credential_id from agents where slug = 'qa'`;
  const spawned = await h.seedAgent({ slug: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string}, terminated_at = now(), terminated_by = '@or' where id = ${spawned.id}`;
  await h.sql`update agents set archived_at = now() where slug = 'qa'`;
  const r = await h.app.tasks.comment(or, "T-1", "@nobody @twin @me @kid @qa done?");
  expect(r.notReached).toEqual([
    { name: "nobody", reason: "unknown" },
    { name: "twin", reason: "ambiguous" },
    { name: "me", reason: "reserved" },
    { name: "kid", reason: "terminated" },
    { name: "qa", reason: "archived" },
  ]);
  expect(r.deliveredTo).toEqual(["dev"]);
});

test("an ended assignee is reported and gets nothing", async () => {
  await h.sql`update agents set archived_at = now() where slug = 'dev'`;
  const before = (await taskRowsTo("dev", "task_comment")).length;
  const r = await h.app.tasks.comment(or, "T-1", "hello");
  expect(r.deliveredTo).toEqual([]);
  expect(r.notReached).toEqual([{ name: "dev", reason: "archived" }]);
  expect(await taskRowsTo("dev", "task_comment")).toHaveLength(before);
});

test("51 distinct mentions: 50 resolved, the rest too_many", async () => {
  const body = Array.from({ length: 51 }, (_, i) => `@nobody${i}`).join(" ");
  const r = await h.app.tasks.comment(or, "T-1", body);
  expect(r.notReached.filter((x) => x.reason === "unknown")).toHaveLength(50);
  expect(r.notReached.filter((x) => x.reason === "too_many")).toEqual([
    { name: "nobody50", reason: "too_many" },
  ]);
});

test("a mention after an escape in the same text node is still a mention; an escaped one is not", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "\\* @sam and \\@or");
  expect(r.mentionedHumans).toEqual(["@sam"]);
  expect(r.notReached).toEqual([]);
  expect(await inbox(ids.sam as string)).toHaveLength(1);
  expect(await inbox(ids.or as string)).toHaveLength(0);
});

test("an unrelated agent may comment; an empty comment and an unknown task are refused", async () => {
  const r = await h.app.tasks.comment(agent("qa"), "T-1", "FYI");
  expect(r.deliveredTo).toEqual(["dev"]);
  await expect(h.app.tasks.comment(or, "T-1", "   ")).rejects.toMatchObject({
    message: "Write a comment first.",
  });
  await expect(h.app.tasks.comment(or, "T-77", "x")).rejects.toBeInstanceOf(TaskError);
});

test("a comment bumps the task's updated time", async () => {
  const before = new Date((await h.sql`select updated_at from tasks`)[0]?.updated_at);
  await h.app.tasks.comment(or, "T-1", "hi");
  const after = new Date((await h.sql`select updated_at from tasks`)[0]?.updated_at);
  expect(after.getTime()).toBeGreaterThan(before.getTime());
});
