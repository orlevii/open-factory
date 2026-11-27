import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../../agents/testing/fake-driver.ts";
import type { Actor } from "../../tasks/permission.ts";
import { agentRowOf, makeTestApp, signUp } from "../../test/helpers.ts";
import { asRunning } from "../../test/running.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let or: Actor;
const ids: Record<string, string> = {};
const tok: Record<string, string> = {};

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  const u = await signUp(h.app, { handle: "or" });
  const [orPrincipal] = await h.sql`select ref from principals where handle = 'or'`;
  or = { kind: "human", id: u.user.id, ref: String(orPrincipal?.ref), handle: "or" };
  for (const handle of ["lead", "dev", "qa"]) {
    ids[handle] = (await h.seedAgent({ handle })).id;
    tok[handle] = h.app.agentTokens.mint(ids[handle] as string).token;
  }
  await h.sql`update agents set reports_to = ${ids.lead as string} where id = (select id from principals where handle = 'dev')`;
});
afterEach(() => h.close());

const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";
const call = async (who: string, name: string, args: object) => {
  const r = await callTool(url, tok[who] as string, name, args);
  return {
    err: r.isError === true,
    text: text(r),
    json: r.isError ? undefined : JSON.parse(text(r)),
  };
};
const names = async (who: string) =>
  (
    (await mcpCall(url, tok[who] as string, "tools/list", {})).json.result.tools as {
      name: string;
    }[]
  )
    .map((t) => t.name)
    .sort();

test("a spawner lists the spawn tools only while its process runs with them", async () => {
  const base = await names("qa"); // the full base list is asserted in app.test.ts
  // I2 §6.2: the spawn tools follow the config the running process started with.
  await h.sql`update agents set config = '{"template":{"can_spawn":["test"]}}'::jsonb where id = (select id from principals where handle = 'lead')`;
  const lead = await agentRowOf(h.app, "lead");
  if (!lead) throw new Error("no lead");
  expect(await names("lead")).toEqual(base);
  await asRunning(h.app, lead);
  expect(await names("lead")).toEqual([...base, "spawn_agent", "terminate_agent"].sort());
});

test("create_task acts as the token's agent; me assigns the caller and sends it nothing", async () => {
  const r = await call("lead", "create_task", {
    title: "Plan",
    assignee: "me",
    depends_on: [],
    links: [{ kind: "pr", target: "https://github.com/a/b/pull/1" }],
  });
  expect(r.json).toEqual({
    key: "T-1",
    status: "open",
    assignee: expect.stringMatching(/^<@[0-9a-z]{8}\|lead>$/),
    blocked_by: [],
  });
  const [row] = await h.sql`select created_by_id from tasks`;
  expect(row?.created_by_id).toBe(ids.lead);
  expect((await h.sql`select 1 from messages where task_id is not null`).length).toBe(0);
  // Identity never comes from arguments.
  const spoof = await call("qa", "create_task", { title: "x", created_by: "lead" });
  expect(spoof.err).toBe(false);
  expect((await h.sql`select created_by_id from tasks where title = 'x'`)[0]?.created_by_id).toBe(
    ids.qa,
  );
});

test("update_task: null unassigns, a no-op reports changed [], an unrelated agent is refused but may comment", async () => {
  await call("lead", "create_task", { title: "Plan", assignee: "dev", depends_on: [] });
  const un = await call("lead", "update_task", { id: "T-1", assignee: null });
  expect(un.json).toMatchObject({ key: "T-1", changed: ["assignee"] });
  expect(un.json.assignee).toBeUndefined();
  expect((await call("lead", "update_task", { id: "t-1", status: "open" })).json.changed).toEqual(
    [],
  );
  const no = await call("qa", "update_task", { id: "T-1", status: "done" });
  expect(no.err).toBe(true);
  expect(no.text).toBe(
    "Only T-1's creator (@lead) or their managers can change it; comment on it instead.",
  );
  expect(
    (await call("qa", "comment_task", { id: "T-1", body: `FYI <@${or.ref}>` })).json,
  ).toMatchObject({
    mentioned_humans: [`<@${or.ref}|or>`],
    delivered_to: [],
    not_reached: [],
  });
  expect((await call("qa", "update_task", { id: "T-9", status: "done" })).text).toBe(
    "No task T-9.",
  );
});

test("comment_task reports a mentioned human as reached", async () => {
  await call("lead", "create_task", { title: "Plan", assignee: "dev" });
  const r = await call("dev", "comment_task", { id: "T-1", body: `look <@${or.ref}|or>` });
  expect(r.err).toBe(false);
  expect(r.json).toMatchObject({ mentioned_humans: [`<@${or.ref}|or>`], not_reached: [] });
});

test("get_task shows a mention in the body and in comments with the principal's current handle", async () => {
  const [qa] = await h.sql`select ref from principals where handle = 'qa'`;
  await call("lead", "create_task", {
    title: "Plan",
    body: `ask <@${qa?.ref}|stale-label>`,
    assignee: "dev",
  });
  await call("dev", "comment_task", { id: "T-1", body: `<@${qa?.ref}> please look` });
  await h.sql`update principals set handle = 'qa-renamed' where ref = ${qa?.ref as string}`;
  try {
    const t = (await call("dev", "get_task", { id: "T-1" })).json;
    expect(t.body).toBe(`ask <@${qa?.ref}|qa-renamed>`);
    expect(t.comments[0].body).toBe(`<@${qa?.ref}|qa-renamed> please look`);
  } finally {
    await h.sql`update principals set handle = 'qa' where ref = ${qa?.ref as string}`;
  }
});

test("task titles that carry a mention read back as <@ref|handle> in list_tasks and get_task", async () => {
  const [qa] = await h.sql`select ref from principals where handle = 'qa'`;
  await call("lead", "create_task", { title: `Ask <@${qa?.ref}> first`, assignee: "dev" });
  await call("lead", "create_task", {
    title: `Then <@${qa?.ref}> ships`,
    depends_on: ["T-1"],
  });
  const want = (t: string) => t.replace("QA", `<@${qa?.ref}|qa>`);
  const listed = (await call("dev", "list_tasks", {})).json.tasks as {
    key: string;
    title: string;
  }[];
  expect(listed.find((t) => t.key === "T-1")?.title).toBe(want("Ask QA first"));
  const t1 = (await call("dev", "get_task", { id: "T-1" })).json;
  expect(t1.title).toBe(want("Ask QA first"));
  expect(t1.blocks[0].title).toBe(want("Then QA ships"));
  const t2 = (await call("dev", "get_task", { id: "T-2" })).json;
  expect(t2.depends_on[0].title).toBe(want("Ask QA first"));
});

test("filtering list_tasks by a person's mention is refused naming the person by handle", async () => {
  const r = await call("lead", "list_tasks", { assignee: `<@${or.ref}|or>` });
  expect(r.err).toBe(true);
  expect(r.text).toBe("No agent @or.");
});

test("comment_task: a plain @handle reaches the agent and warns; an unknown ref is refused and nothing is posted", async () => {
  await call("lead", "create_task", { title: "Plan", assignee: "lead" });
  const [qa] = await h.sql`select ref from principals where handle = 'qa'`;
  const r = await call("dev", "comment_task", { id: "T-1", body: "@qa thoughts?" });
  expect(r.json.delivered_to).toEqual(
    expect.arrayContaining([expect.stringMatching(/^<@[0-9a-z]{8}\|qa>$/)]),
  );
  expect(r.json.warnings).toEqual([
    `Plain mention detected: @qa was resolved to <@${qa?.ref}|qa>. Mention as <@ref|handle>.`,
  ]);
  const bad = await call("dev", "comment_task", { id: "T-1", body: "<@zzzzzzzz> look" });
  expect(bad.err).toBe(true);
  expect(bad.text).toBe(
    "<@zzzzzzzz> isn't anyone in this factory; list_peers shows each agent and human with their mention.",
  );
  expect((await h.sql`select id from task_comments`).length).toBe(1);
  const d = await mcpCall(url, tok.dev as string, "tools/list", {});
  const tool = (d.json.result.tools as { name: string; description: string }[]).find(
    (x) => x.name === "comment_task",
  );
  expect(tool?.description).not.toContain("@humans");
});

test("list_tasks: defaults, filters and the more note", async () => {
  await call("lead", "create_task", { title: "A", assignee: "dev" });
  await call("lead", "create_task", { title: "B" });
  await call("dev", "create_task", { title: "C", assignee: "me" });
  await call("lead", "update_task", { id: "T-2", status: "done" });
  await h.app.tasks.create(or, { title: "D" });
  const keys = async (who: string, args: object) =>
    ((await call(who, "list_tasks", args)).json.tasks as { key: string }[]).map((t) => t.key);
  expect(await keys("qa", {})).toEqual(["T-4", "T-3", "T-1"]);
  expect(await keys("qa", { status: ["done"] })).toEqual(["T-2"]);
  expect(await keys("qa", { unassigned: true })).toEqual(["T-4"]);
  expect(await keys("dev", { assignee: "me" })).toEqual(["T-3", "T-1"]);
  expect(await keys("qa", { created_by: "@or" })).toEqual(["T-4"]);
  expect(await keys("qa", { created_by: "lead" })).toEqual(["T-1"]);
  const cut = await call("qa", "list_tasks", { limit: 1 });
  expect(cut.json.more).toBe(true);
  expect(cut.json.note).toBe(
    "Showing the 1 most recently updated; pass a larger limit (max 200) or narrow the filter.",
  );
  expect((await call("qa", "list_tasks", {})).json).toMatchObject({ more: false });
});

test("list_tasks filters by a creator given as a mention", async () => {
  await h.app.tasks.create(or, { title: "D" });
  await call("lead", "create_task", { title: "A" });
  const [lead] = await h.sql`select ref from principals where handle = 'lead'`;
  const keys = async (who: string, args: object) =>
    ((await call(who, "list_tasks", args)).json.tasks as { key: string }[]).map((t) => t.key);
  expect(await keys("qa", { created_by: `<@${or.ref}|or>` })).toEqual(["T-1"]);
  expect(await keys("qa", { created_by: `<@${String(lead?.ref)}|lead>` })).toEqual(["T-2"]);
});

test("get_task: the newest 50 comments, earlier ones through comments_before", async () => {
  await call("lead", "create_task", { title: "Plan", body: "Brief" });
  for (let i = 1; i <= 60; i++) await h.app.tasks.comment(or, "T-1", `c${i}`);
  const got = await call("qa", "get_task", { id: "T-1" });
  expect(got.text).not.toMatch(/^[^{]/);
  const t = got.json;
  expect(t.comments).toHaveLength(50);
  expect(t.comments[0].body).toBe("c11");
  expect(t.earlier_comments).toBe(10);
  expect(t.note).toBe(
    `10 earlier comments; call get_task with comments_before=${t.comments[0].id} for them.`,
  );
  expect(t).toMatchObject({
    key: "T-1",
    body: "Brief",
    created_by: expect.stringMatching(/^<@[0-9a-z]{8}\|lead>$/),
    depends_on: [],
    blocks: [],
  });
  const more = (await call("qa", "get_task", { id: "T-1", comments_before: t.comments[0].id }))
    .json;
  expect(more.comments.map((c: { body: string }) => c.body)).toEqual(
    Array.from({ length: 10 }, (_, i) => `c${i + 1}`),
  );
  expect(more.earlier_comments).toBe(0);
  expect((await call("qa", "get_task", { id: "T-1", comments_before: "nope" })).err).toBe(true);
});

test("dependencies and links come back through get_task", async () => {
  await call("lead", "create_task", { title: "One" });
  await call("lead", "create_task", {
    title: "Two",
    depends_on: ["T-1"],
    links: [
      { kind: "agent", target: "@dev" },
      { kind: "file", target: "docs/a.md", title: "A" },
    ],
  });
  const two = (await call("qa", "get_task", { id: "T-2" })).json;
  expect(two.blocked_by).toEqual(["T-1"]);
  expect(two.depends_on).toEqual([{ key: "T-1", title: "One", status: "open" }]);
  expect(two.links).toEqual([
    { kind: "agent", agent: expect.stringMatching(/^<@[0-9a-z]{8}\|dev>$/) },
    { kind: "file", target: "docs/a.md", title: "A" },
  ]);
  expect((await call("qa", "get_task", { id: "1" })).json.blocks).toEqual([
    { key: "T-2", title: "Two", status: "open" },
  ]);
});

test("comment_task: a looping peer is listed under held, the comment is still posted", async () => {
  await h.app.factorySettings.update({ loopGuardMessages: 2 }, or.id);
  await call("lead", "create_task", { title: "Plan", assignee: "lead" });
  const send = (from: string, to: string) =>
    h.app.router.send({ agentId: ids[from] as string }, [`@${to}`], "ping", false);
  for (let i = 0; i < 2; i++) {
    await send("dev", "qa");
    await send("qa", "dev");
  }
  await send("qa", "dev");
  const r = await call("dev", "comment_task", { id: "T-1", body: "@qa thoughts?" });
  expect(r.err).toBe(false);
  expect(r.json.delivered_to).toEqual([expect.stringMatching(/^<@[0-9a-z]{8}\|lead>$/)]);
  expect(r.json.held).toHaveLength(1);
  expect(r.json.held[0].to).toMatch(/^<@[0-9a-z]{8}\|qa>$/);
  expect(r.json.held[0].note).toMatch(/^Held: you and <@[0-9a-z]{8}\|qa> exchanged/);
  const [c] = await h.sql`select body from task_comments where id = ${r.json.id}`;
  const [qa] = await h.sql`select ref from principals where handle = 'qa'`;
  expect(c?.body).toBe(`<@${qa?.ref}> thoughts?`);
});

test("a task assignee given as a plain handle warns; given as its mention it does not", async () => {
  const [dev] = await h.sql`select ref from principals where handle = 'dev'`;
  const plain = await call("lead", "create_task", { title: "A", assignee: "dev" });
  expect(plain.json.warnings).toEqual([
    `Plain mention detected: @dev was resolved to <@${dev?.ref}|dev>. Mention as <@ref|handle>.`,
  ]);
  const mentioned = await call("lead", "create_task", {
    title: "B",
    assignee: `<@${dev?.ref}|old>`,
  });
  expect(mentioned.json).toMatchObject({
    assignee: expect.stringMatching(/^<@[0-9a-z]{8}\|dev>$/),
  });
  expect(mentioned.json).not.toHaveProperty("warnings");
});
