import type { AddressInfo } from "node:net";
import type { TaskDetail, TaskPage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";
import { testRef } from "../test/principals.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let sam: Awaited<ReturnType<typeof signUp>>;
const ids: Record<string, string> = {};

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  or = await signUp(h.app, { handle: "or" });
  sam = await signUp(h.app, { handle: "sam" });
  for (const slug of ["lead", "dev", "qa"]) ids[slug] = (await h.seedAgent({ slug })).id;
});
afterEach(() => h.close());

const as = (who: typeof or) => ({ cookie: who.cookie });
const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, who = or) =>
  h.app.inject({ method, url, headers: as(who), ...(payload ? { payload } : {}) });
const create = async (payload: object, who = or) => {
  const r = await call("POST", "/api/tasks", payload, who);
  expect(r.statusCode).toBe(201);
  return r.json().task as TaskDetail;
};

test.each([
  ["GET", "/api/tasks"],
  ["POST", "/api/tasks"],
  ["GET", "/api/tasks/T-1"],
  ["PATCH", "/api/tasks/T-1"],
  ["POST", "/api/tasks/T-1/comments"],
] as const)(
  "%s %s needs a human session: no auth and a live agent token both get 401",
  async (method, url) => {
    const none = await h.app.inject({ method, url, payload: {} });
    expect(none.statusCode).toBe(401);
    const { token } = h.app.agentTokens.mint(ids.dev as string);
    const agent = await h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(agent.statusCode).toBe(401);
  },
);

test("POST creates (201) as the human; the detail has history and the creator", async () => {
  const t = await create({ title: "Plan", body: "Brief", assignee: "dev" });
  expect(t).toMatchObject({
    key: "T-1",
    title: "Plan",
    status: "open",
    assignee: { slug: "dev" },
    blockedBy: [],
  });
  expect(t.createdBy).toMatchObject({ kind: "human", ref: expect.any(String), handle: "or" });
  expect(t.activity.map((a) => (a.type === "event" ? a.event : a.type))).toEqual([
    "created",
    "assignee",
  ]);
  const assignee = t.activity[1];
  expect(assignee).toMatchObject({ event: "assignee", from: null, to: "dev" });
});

test("a task created by a human lists its creator as that human", async () => {
  await create({ title: "Plan" });
  const ref = testRef(or.user.id);
  const list = (await call("GET", "/api/tasks")).json() as TaskPage;
  expect(list.tasks[0]).toMatchObject({
    key: "T-1",
    createdBy: { kind: "human", ref, handle: "or" },
  });
  const detail = await call("GET", "/api/tasks/T-1");
  expect(detail.json()).toMatchObject({ createdBy: { kind: "human", ref, handle: "or" } });
});

test("validation: a javascript: link is a 400 on links; an unknown dependency on dependsOn; an ended assignee is 409", async () => {
  const bad = await call("POST", "/api/tasks", {
    title: "x",
    links: [{ kind: "url", target: "javascript:alert(1)" }],
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error.fields.links).toBe("Links must be http(s) URLs.");
  const dep = await call("POST", "/api/tasks", { title: "x", dependsOn: ["T-9"] });
  expect(dep.json().error.fields).toEqual({ dependsOn: "No task T-9." });
  await h.sql`update agents set archived_at = now() where slug = 'qa'`;
  const ended = await call("POST", "/api/tasks", { title: "x", assignee: "qa" });
  expect(ended.statusCode).toBe(409);
  expect(ended.json().error).toMatchObject({
    code: "assignee_ended",
    message: "@qa was archived and can't be assigned tasks.",
  });
  expect((await call("POST", "/api/tasks", { title: "" })).json().error.fields.title).toBe(
    "Enter a title.",
  );
});

test("PATCH: any subset, a cycle is 400 on dependsOn, unknown is 404, null unassigns", async () => {
  await create({ title: "a" });
  await create({ title: "b", dependsOn: ["T-1"], assignee: "dev" });
  const cyc = await call("PATCH", "/api/tasks/T-1", { dependsOn: ["T-2"] });
  expect(cyc.statusCode).toBe(400);
  expect(cyc.json().error.fields.dependsOn).toBe(
    "T-2 already depends on T-1; that would make a cycle.",
  );
  const un = await call("PATCH", "/api/tasks/T-2", { assignee: null, status: "in_progress" });
  expect(un.statusCode).toBe(200);
  expect(un.json().task).toMatchObject({
    status: "in_progress",
    assignee: null,
    blockedBy: ["T-1"],
  });
  const missing = await call("PATCH", "/api/tasks/T-99", { status: "done" });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toMatchObject({ code: "task_not_found", message: "No task T-99." });
  expect((await call("GET", "/api/tasks/T-99")).statusCode).toBe(404);
});

test("GET /api/tasks: default filter, status=all, repeated status, assignee, unassigned, creator, keys", async () => {
  await create({ title: "one", assignee: "dev" });
  await create({ title: "two" });
  await create({ title: "three", assignee: "qa" }, sam);
  await call("PATCH", "/api/tasks/T-2", { status: "done" });
  await call("PATCH", "/api/tasks/T-3", { status: "cancelled" });
  const keys = async (q: string) =>
    ((await call("GET", `/api/tasks${q}`)).json() as TaskPage).tasks.map((t) => t.key);
  expect(await keys("")).toEqual(["T-1"]);
  expect((await keys("?status=all")).sort()).toEqual(["T-1", "T-2", "T-3"]);
  expect((await keys("?status=done&status=cancelled")).sort()).toEqual(["T-2", "T-3"]);
  expect(await keys("?status=all&assignee=dev")).toEqual(["T-1"]);
  expect(await keys("?status=all&unassigned=true")).toEqual(["T-2"]);
  expect((await keys("?status=all&creator=me")).sort()).toEqual(["T-1", "T-2"]);
  expect(await keys("?status=all&creator=@sam")).toEqual(["T-3"]);
  expect((await keys("?keys=T-1,T-3")).sort()).toEqual(["T-1", "T-3"]);
  expect((await call("GET", "/api/tasks?assignee=nobody")).statusCode).toBe(400);
});

test("GET /api/tasks?q matches titles case-insensitively; % and _ are literal", async () => {
  await create({ title: "Fix 100% CPU" });
  await create({ title: "Fix 100x CPU" });
  await create({ title: "snake_case" });
  await create({ title: "snakeXcase" });
  await create({ title: "back\\slash" });
  await call("PATCH", "/api/tasks/T-2", { status: "done" });
  const titles = async (q: string) =>
    (
      (await call("GET", `/api/tasks?status=all&q=${encodeURIComponent(q)}`)).json() as TaskPage
    ).tasks
      .map((t) => t.title)
      .sort();
  expect(await titles("100%")).toEqual(["Fix 100% CPU"]);
  expect(await titles("snake_")).toEqual(["snake_case"]);
  expect(await titles("FIX")).toEqual(["Fix 100% CPU", "Fix 100x CPU"]);
  expect(await titles("k\\s")).toEqual(["back\\slash"]);
  expect(await titles("%")).toEqual(["Fix 100% CPU"]);
  expect(await titles("_")).toEqual(["snake_case"]);
  // the default status filter still applies
  const open = (await call("GET", "/api/tasks?q=fix")).json() as TaskPage;
  expect(open.tasks.map((t) => t.title)).toEqual(["Fix 100% CPU"]);
});

test("GET /api/tasks?q validates: empty is 400, over 200 characters is 400", async () => {
  expect((await call("GET", "/api/tasks?q=")).statusCode).toBe(400);
  expect((await call("GET", "/api/tasks?q=%20%20")).statusCode).toBe(400);
  expect((await call("GET", `/api/tasks?q=${"a".repeat(201)}`)).statusCode).toBe(400);
  expect((await call("GET", `/api/tasks?q=${"a".repeat(200)}`)).statusCode).toBe(200);
});

test("GET /api/tasks?q with a NUL byte is 400, not a Postgres error", async () => {
  expect((await call("GET", "/api/tasks?q=%00")).statusCode).toBe(400);
  expect((await call("GET", "/api/tasks?q=a%00b")).statusCode).toBe(400);
});

test("GET /api/tasks: Agent details' query (assignee, limit 5, default status) lists open and in-progress only", async () => {
  await create({ title: "one", assignee: "dev" });
  await create({ title: "two", assignee: "dev" });
  await create({ title: "three", assignee: "dev" });
  await call("PATCH", "/api/tasks/T-2", { status: "in_progress" });
  await call("PATCH", "/api/tasks/T-3", { status: "done" });
  const r = await call("GET", "/api/tasks?assignee=dev&limit=5");
  expect(r.statusCode).toBe(200);
  expect((r.json() as TaskPage).tasks.map((t) => t.key).sort()).toEqual(["T-1", "T-2"]);
  // The client's own "open and in progress" sentinel is not a status the server knows.
  expect((await call("GET", "/api/tasks?status=open_in_progress")).statusCode).toBe(400);
});

test("paging: newest updated first, a cursor, an invalid cursor is 400 on before", async () => {
  for (const t of ["a", "b", "c"]) await create({ title: t });
  const p1 = (await call("GET", "/api/tasks?limit=2")).json() as TaskPage;
  expect(p1.tasks.map((t) => t.key)).toEqual(["T-3", "T-2"]);
  expect(p1.nextCursor).not.toBeNull();
  const p2 = (
    await call("GET", `/api/tasks?limit=2&before=${encodeURIComponent(p1.nextCursor as string)}`)
  ).json() as TaskPage;
  expect(p2.tasks.map((t) => t.key)).toEqual(["T-1"]);
  expect(p2.nextCursor).toBeNull();
  const bad = await call("GET", "/api/tasks?before=garbage");
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error.fields.before).toEqual(expect.any(String));
});

test("GET detail: activity oldest first with comments and history interleaved; blocks lists dependents with blocked", async () => {
  await create({ title: "base" });
  await create({ title: "next", dependsOn: ["T-1"], assignee: "dev" });
  await call("PATCH", "/api/tasks/T-1", { status: "in_progress" });
  const [dev] = await h.sql`select ref from principals where handle = 'dev'`;
  const c = await call("POST", "/api/tasks/T-1/comments", { body: `<@${dev?.ref}> look at this` });
  expect(c.statusCode).toBe(201);
  expect(c.json()).toMatchObject({
    comment: {
      type: "comment",
      author: { kind: "human", ref: expect.any(String), handle: "or" },
      body: `<@${dev?.ref}> look at this`,
    },
    deliveredTo: ["dev"],
    mentionedHumans: [],
    notReached: [],
  });
  const d = (await call("GET", "/api/tasks/T-1")).json() as TaskDetail;
  expect(d.activity.map((a) => (a.type === "event" ? a.event : "comment"))).toEqual([
    "created",
    "status",
    "comment",
  ]);
  expect(d.blocks).toEqual([
    { key: "T-2", title: "next", status: "open", blocked: true, assignee: "dev" },
  ]);
  const next = (await call("GET", "/api/tasks/T-2")).json() as TaskDetail;
  expect(next.dependsOn).toEqual([
    { key: "T-1", title: "base", status: "in_progress", blocked: false },
  ]);
  expect(next.blockedBy).toEqual(["T-1"]);
});

test("a comment's tag reaches the tagged agent", async () => {
  await create({ title: "t", assignee: "lead" });
  const [dev] = await h.sql`select ref from principals where handle = 'dev'`;
  const [samP] = await h.sql`select ref from principals where handle = 'sam'`;
  const r = await call("POST", "/api/tasks/T-1/comments", {
    body: `look <@${dev?.ref}> and <@${samP?.ref}>`,
  });
  expect(r.statusCode).toBe(201);
  expect(r.json()).toMatchObject({
    deliveredTo: expect.arrayContaining(["dev"]),
    mentionedHumans: [{ ref: samP?.ref, handle: "sam" }],
    notReached: [],
  });
  const rows = await h.sql`select to_id from messages where comment_id is not null order by to_id`;
  expect(rows.map((x) => x.to_id)).toContain(ids.dev);
  expect(
    (await call("POST", "/api/tasks/T-1/comments", { body: "  " })).json().error.fields.body,
  ).toBe("Write a comment first.");
});

test("a comment with an unknown ref is 400 on body and writes no comment", async () => {
  await create({ title: "t", assignee: "dev" });
  const r = await call("POST", "/api/tasks/T-1/comments", { body: "look <@zzzzzzzz>" });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatchObject({
    code: "unknown_tag",
    fields: { body: "Tag isn't anyone here" },
  });
  expect(await h.sql`select id from task_comments`).toEqual([]);
});

test("a task title with a tag is stored as <@ref>", async () => {
  const [dev] = await h.sql`select ref from principals where handle = 'dev'`;
  const t = await create({ title: `Review for <@${dev?.ref}|dev>` });
  expect(t.title).toBe(`Review for <@${dev?.ref}>`);
  const bad = await call("POST", "/api/tasks", { title: "Review for <@zzzzzzzz>" });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error.fields.title).toBe("Tag isn't anyone here");
});

test("GET /api/agents carries openTasks", async () => {
  await create({ title: "a", assignee: "dev" });
  await create({ title: "b", assignee: "dev" });
  await call("PATCH", "/api/tasks/T-2", { status: "done" });
  const agents = (await call("GET", "/api/agents")).json().agents as {
    slug: string;
    openTasks: number;
  }[];
  expect(Object.fromEntries(agents.map((a) => [a.slug, a.openTasks]))).toEqual({
    lead: 0,
    dev: 1,
    qa: 0,
  });
});

test("a create publishes tasks_changed to a connected WebSocket", async () => {
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/api/ws`;
  const ws = new WebSocket(url, { headers: { cookie: or.cookie, origin: TEST_ORIGIN } });
  const frames: unknown[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  // Resolves once a frame matching `want` has arrived (checked on every message; no polling).
  const arrived = (want: (f: { type: string }) => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        const hit = frames.some((f) => want(f as { type: string }));
        if (hit) resolve();
        return hit;
      };
      if (!check()) ws.on("message", check);
    });
  await arrived((f) => f.type === "hello");
  await create({ title: "live" });
  await arrived((f) => f.type === "tasks_changed");
  expect(frames).toContainEqual({ type: "tasks_changed", keys: ["T-1"] });
  ws.close();
});
