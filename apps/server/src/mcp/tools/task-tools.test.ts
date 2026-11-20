import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../../agents/testing/fake-driver.ts";
import type { Actor } from "../../tasks/permission.ts";
import { makeTestApp, signUp } from "../../test/helpers.ts";
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
  or = { kind: "user", userId: u.user.id, handle: "or" };
  for (const slug of ["lead", "dev", "qa"]) {
    ids[slug] = (await h.seedAgent({ slug })).id;
    tok[slug] = h.app.agentTokens.mint(ids[slug] as string).token;
  }
  await h.sql`update agents set reports_to = ${ids.lead as string} where slug = 'dev'`;
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

test("every agent lists the five task tools; a spawner has two more", async () => {
  const base = [
    "comment_task",
    "create_task",
    "get_task",
    "list_peers",
    "list_tasks",
    "send_message",
    "update_task",
  ];
  expect(await names("qa")).toEqual(base);
  await h.sql`update agents set config = jsonb_set(jsonb_set(config, '{canSpawn}', '["x"]'), '{maxLiveSpawns}', '3') where slug = 'lead'`;
  expect(await names("lead")).toEqual([...base, "spawn_agent", "terminate_agent"].sort());
});

test("create_task acts as the token's agent; me assigns the caller and sends it nothing", async () => {
  const r = await call("lead", "create_task", {
    title: "Plan",
    assignee: "me",
    depends_on: [],
    links: [{ kind: "pr", target: "https://github.com/a/b/pull/1" }],
  });
  expect(r.json).toEqual({ key: "T-1", status: "open", assignee: "lead", blocked_by: [] });
  const [row] = await h.sql`select created_by_agent_id from tasks`;
  expect(row?.created_by_agent_id).toBe(ids.lead);
  expect((await h.sql`select 1 from messages where task_id is not null`).length).toBe(0);
  // Identity never comes from arguments.
  const spoof = await call("qa", "create_task", { title: "x", created_by: "lead" });
  expect(spoof.err).toBe(false);
  expect(
    (await h.sql`select created_by_agent_id from tasks where title = 'x'`)[0]?.created_by_agent_id,
  ).toBe(ids.qa);
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
  expect((await call("qa", "comment_task", { id: "T-1", body: "FYI @or" })).json).toMatchObject({
    mentioned_humans: ["@or"],
    delivered_to: [],
    not_reached: [],
  });
  expect((await call("qa", "update_task", { id: "T-9", status: "done" })).text).toBe(
    "No task T-9.",
  );
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
  expect((await call("qa", "list_tasks", {})).json).toMatchObject({ more: false });
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
    created_by: "lead",
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
    { kind: "agent", agent: "dev" },
    { kind: "file", target: "docs/a.md", title: "A" },
  ]);
  expect((await call("qa", "get_task", { id: "1" })).json.blocks).toEqual([
    { key: "T-2", title: "Two", status: "open" },
  ]);
});

test("list_tasks carries the more note whenever it is cut, naming the limit", async () => {
  for (const t of ["a", "b", "c"]) await call("lead", "create_task", { title: t });
  const cut = await call("qa", "list_tasks", { limit: 2 });
  expect(cut.json.more).toBe(true);
  expect(cut.json.note).toBe(
    "Showing the 2 most recently updated; pass a larger limit (max 200) or narrow the filter.",
  );
});
