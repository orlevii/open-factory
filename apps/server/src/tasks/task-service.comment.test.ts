import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { agentRowOf, makeTestApp, runtimeOf, signUp } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";
import { TaskError } from "./errors.ts";
import type { Actor } from "./permission.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let or: Actor;
const ids: Record<string, string> = {};
const agent = (handle: string): Actor => ({
  kind: "agent",
  id: ids[handle] as string,
  ref: testRef(ids[handle] as string),
  handle: handle,
});

beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  const u1 = await signUp(h.app, { handle: "or" });
  const u2 = await signUp(h.app, { handle: "sam" });
  or = { kind: "human", id: u1.user.id, ref: testRef(u1.user.id), handle: "or" };
  ids.or = u1.user.id;
  ids.sam = u2.user.id;
  for (const handle of ["lead", "dev", "qa"]) ids[handle] = (await h.seedAgent({ handle })).id;
  await h.app.tasks.create(or, { title: "Plan", assignee: "dev" });
});
afterEach(() => h.close());

/** A principal's stored tag (the test seeds derive a ref from the id). */
const tag = (who: string) => `<@${testRef(ids[who] as string)}>`;
const person = (who: string) => ({ ref: testRef(ids[who] as string), handle: who });

const settle = async (...handles: string[]) => {
  for (const s of handles) await (await runtimeOf(h.app, s))?.settled();
};
const proc = (handle: string) => driver.startsOf(handle).at(-1);
const inbox = (userId: string) =>
  h.sql`select i.kind, i.read_at, m.body, m.from_id, m.from_id, m.comment_id
    from inbox_items i join messages m on m.id = i.message_id where i.user_id = ${userId} order by i.created_at`;
const taskRowsTo = (handle: string, kind: string) =>
  h.sql`select m.id, m.body, m.from_id, m.from_id, m.comment_id, m.state from messages m
    join agents a on a.id = m.to_id where a.id = (select id from principals where handle = ${handle}) and m.kind = ${kind}`;

test("AC 2 (server side): an agent mentions a human: one unread mention item, nothing to the author", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "@or can you confirm?");
  expect(r).toMatchObject({ deliveredTo: [], mentionedHumans: [person("or")], notReached: [] });
  const items = await inbox(ids.or as string);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "mention", read_at: null, comment_id: r.id });
  expect(await taskRowsTo("dev", "task_comment")).toHaveLength(0);
  expect(await inbox(ids.sam as string)).toHaveLength(0);
});

test("a human's comment mentioning an agent reaches it as task_comment from the human, waking with message", async () => {
  await settle("dev");
  const r = await h.app.tasks.comment(or, "T-1", `${tag("qa")} yes, go ahead`);
  expect(r.deliveredTo.map((d) => d.handle)).toEqual(["dev", "qa"]);
  await settle("dev", "qa");
  const sent = proc("qa")?.sent.flat()[0];
  expect(sent).toMatchObject({
    from: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/),
    kind: "task_comment",
    taskKey: "T-1",
    commentId: r.id,
    body: `<@${testRef(ids.qa as string)}|qa> yes, go ahead`,
  });
  const qa = await agentRowOf(h.app, "qa");
  const started = (await h.app.store.after(qa?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "message" }),
  );
});

test("an agent's comment to another agent wakes it with task_message", async () => {
  await h.app.tasks.comment(agent("dev"), "T-1", "@qa please review");
  await settle("qa");
  const qa = await agentRowOf(h.app, "qa");
  const started = (await h.app.store.after(qa?.id ?? "", 0, 100)).map((e) => e.event);
  expect(started).toContainEqual(
    expect.objectContaining({ type: "process_started", reason: "task_message" }),
  );
});

test("a user tagged alongside @humans gets one item; @humans is plain text and reaches nobody", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "@sam @humans");
  expect(r).toMatchObject({
    deliveredTo: [],
    mentionedHumans: [person("sam")],
    notReached: [],
  });
  expect(await inbox(ids.sam as string)).toHaveLength(1);
  expect(await inbox(ids.or as string)).toHaveLength(0);
  expect(
    await h.sql`select id from messages where kind = 'task_comment' and to_all_humans`,
  ).toEqual([]);
});

test("mentions in code create nothing", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", "`@or` and\n```\n@sam\n```");
  expect(r).toMatchObject({ mentionedHumans: [], notReached: [] });
  expect(await inbox(ids.or as string)).toHaveLength(0);
  expect(await inbox(ids.sam as string)).toHaveLength(0);
});

test("not_reached: a terminated and an archived agent, in order", async () => {
  const spawned = await h.seedAgent({ handle: "kid" });
  ids.kid = spawned.id;
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string}, terminated_at = now(), terminated_by = null where id = ${spawned.id}`;
  await h.sql`update agents set archived_at = now() where id = (select id from principals where handle = 'qa')`;
  const r = await h.app.tasks.comment(or, "T-1", `${tag("kid")} ${tag("qa")} done?`);
  expect(r.notReached).toEqual([
    { name: "kid", reason: "terminated" },
    { name: "qa", reason: "archived" },
  ]);
  expect(r.deliveredTo.map((d) => d.handle)).toEqual(["dev"]);
});

test("an ended assignee is reported and gets nothing", async () => {
  await h.sql`update agents set archived_at = now() where id = (select id from principals where handle = 'dev')`;
  const before = (await taskRowsTo("dev", "task_comment")).length;
  const r = await h.app.tasks.comment(or, "T-1", "hello");
  expect(r.deliveredTo.map((d) => d.handle)).toEqual([]);
  expect(r.notReached).toEqual([{ name: "dev", reason: "archived" }]);
  expect(await taskRowsTo("dev", "task_comment")).toHaveLength(before);
});

test("51 distinct tags: 50 reached, the rest too_many", async () => {
  const handles: string[] = [];
  for (let i = 0; i < 51; i++) {
    const handle = `peer${i}`;
    ids[handle] = (await h.seedAgent({ handle })).id;
    handles.push(handle);
  }
  const r = await h.app.tasks.comment(or, "T-1", handles.map(tag).join(" "));
  expect(r.deliveredTo).toHaveLength(51); // the assignee and the 50 first tags
  expect(r.notReached).toEqual([{ name: "peer50", reason: "too_many" }]);
});

test("a mention after an escape in the same text node is still a mention; an escaped one is not", async () => {
  const r = await h.app.tasks.comment(agent("dev"), "T-1", `\\* @sam and \\@or and \\${tag("or")}`);
  expect(r.mentionedHumans).toEqual([person("sam")]);
  expect(r.notReached).toEqual([]);
  expect(await inbox(ids.sam as string)).toHaveLength(1);
  expect(await inbox(ids.or as string)).toHaveLength(0);
});

test("an unrelated agent may comment; an empty comment and an unknown task are refused", async () => {
  const r = await h.app.tasks.comment(agent("qa"), "T-1", "FYI");
  expect(r.deliveredTo.map((d) => d.handle)).toEqual(["dev"]);
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

describe("loop guard on task comments", () => {
  const N = 2;
  beforeEach(async () => {
    await h.app.factorySettings.update({ loopGuardMessages: N }, ids.or as string);
  });
  const send = (from: string, to: string) =>
    h.app.router.send({ agentId: ids[from] as string }, [`@${to}`], "ping", false);
  /** Each direction sends N messages and qa one more, so the next row from dev exceeds N both ways. */
  async function loopDevQa() {
    for (let i = 0; i < N; i++) {
      await send("dev", "qa");
      await send("qa", "dev");
    }
    await send("qa", "dev");
  }

  test("an agent comment mentioning a looping peer is posted, the peer's row is held and the result says so", async () => {
    await loopDevQa();
    const r = await h.app.tasks.comment(agent("dev"), "T-1", "@qa what do you think?");
    expect(r.deliveredTo.map((d) => d.handle)).toEqual([]);
    expect(r.held).toHaveLength(1);
    expect(r.held[0]?.to).toMatch(/^<@[0-9a-z]{8}\|qa>$/);
    expect(r.held[0]?.note).toMatch(
      /^Held: you and <@[0-9a-z]{8}\|qa> exchanged \d+ messages in 1 minute with no human in between/,
    );
    const [c] = await h.sql`select body from task_comments where id = ${r.id}`;
    expect(c?.body).toBe(`${tag("qa")} what do you think?`);
    const rows = await taskRowsTo("qa", "task_comment");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "loop_held" });
    const [hold] = await h.sql`select count(*)::int as n from loop_holds where resumed_at is null`;
    expect(hold?.n).toBe(1);
  });

  test("a later comment into an open hold gets the later-row note", async () => {
    await loopDevQa();
    await h.app.tasks.comment(agent("dev"), "T-1", "@qa one");
    const r = await h.app.tasks.comment(agent("dev"), "T-1", "@qa two");
    expect(r.held).toEqual([
      {
        to: expect.stringMatching(/^<@[0-9a-z]{8}\|qa>$/),
        note: expect.stringMatching(
          /^Held: messages between you and <@[0-9a-z]{8}\|qa> are held until a human resumes them in the Inbox; it is sent on then\.$/,
        ),
      },
    ]);
  });

  test("only the mentioned agent whose pair is held is held; the others are delivered", async () => {
    await loopDevQa();
    const r = await h.app.tasks.comment(agent("lead"), "T-1", "@qa @dev hi");
    expect(r.held).toEqual([]);
    expect(r.deliveredTo.map((d) => d.handle).sort()).toEqual(["dev", "qa"]);
    const r2 = await h.app.tasks.comment(agent("dev"), "T-1", "@qa @lead hi");
    expect(r2.held.map((x) => x.to)).toEqual([expect.stringMatching(/^<@[0-9a-z]{8}\|qa>$/)]);
    expect(r2.deliveredTo.map((d) => d.handle)).toEqual(["lead"]);
  });

  test("a human comment is never checked, however many messages the pair exchanged", async () => {
    await loopDevQa();
    await h.app.tasks.comment(agent("dev"), "T-1", "@qa trip");
    const r = await h.app.tasks.comment(or, "T-1", `${tag("qa")} please`);
    expect(r.held).toEqual([]);
    expect(r.deliveredTo.map((d) => d.handle)).toContain("qa");
  });
});
