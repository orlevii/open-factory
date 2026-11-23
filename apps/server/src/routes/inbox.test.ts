import { afterEach, beforeEach, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let driver: FakeDriver;
let cookie: string;
let tokA: string;
let url: string;
beforeEach(async () => {
  driver = new FakeDriver();
  h = await makeTestApp({ harnessDriver: driver });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  await h.seedAgent({ slug: "ada" });
  await h.seedAgent({ slug: "bob" });
  cookie = (await signUp(h.app, { handle: "or" })).cookie;
  await h.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { to: ["ada"], body: "hi" },
  });
  driver.last.emit(...ev.fullTurn("sess-a"));
  await (await h.app.runtimes.bySlug("ada"))?.settled();
  tokA = driver.last.spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
});
afterEach(() => h.close());

const get = (path: string, headers: Record<string, string> = { cookie }) =>
  h.app.inject({ method: "GET", url: path, headers });
const procOf = (slug: string) => {
  const p = driver.starts.filter((s) => s.spec.slug === slug).at(-1);
  if (!p) throw new Error(`${slug} not started`);
  return p;
};
/** `ada` opens a turn and records the `send_message` tool call Claude would make before calling the tool. */
async function aCalls(toolUseId: string, input: object) {
  procOf("ada").emit(ev.turn(), {
    type: "tool_call",
    toolUseId,
    name: "mcp__factory__send_message",
    input,
  });
  await (await h.app.runtimes.bySlug("ada"))?.settled();
  return callTool(url, tokA, "send_message", input, toolUseId);
}

test("GET /api/inbox: agent messages are chats, not items; the preview is plain text capped at 280; human session only", async () => {
  await aCalls("toolu_01X", { to: ["@or"], body: "first" });
  await callTool(url, tokA, "send_message", {
    to: ["@or"],
    body: `**${"x".repeat(400)}**`,
    urgent: true,
  });
  const r = await get("/api/inbox");
  expect(r.statusCode).toBe(200);
  const page = r.json();
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(page.chats).toEqual([
    {
      agent: {
        slug: "ada",
        displayName: expect.any(String),
        template: expect.any(String),
        avatarVersion: null,
        kind: "persistent",
        status: expect.any(String),
        archivedAt: null,
      },
      unread: 2,
      latest: {
        messageId: expect.any(String),
        preview: "x".repeat(280),
        createdAt: expect.any(String),
        urgent: true,
      },
    },
  ]);
  expect((await get("/api/inbox", {})).statusCode).toBe(401);
});

test("chats lists every agent with unread messages, newest first; ?unread=true includes them; byAgent is unchanged", async () => {
  await callTool(url, tokA, "send_message", { to: ["@or"], body: "from ada" });
  await h.app.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { to: ["bob"], body: "wake bob" },
  });
  procOf("bob").emit(...ev.fullTurn("sess-b"));
  await (await h.app.runtimes.bySlug("bob"))?.settled();
  const tokB = procOf("bob").spec.env.OPEN_FACTORY_AGENT_TOKEN as string;
  await callTool(url, tokB, "send_message", { to: ["@or"], body: "from bob" });
  await callTool(url, tokB, "send_message", { to: ["@or"], body: "bob again" });
  for (const path of ["/api/inbox", "/api/inbox?unread=true&limit=5"]) {
    const { chats, items } = (await get(path)).json();
    expect(items).toEqual([]);
    expect(
      chats.map((c: { agent: { slug: string }; unread: number }) => [c.agent.slug, c.unread]),
    ).toEqual([
      ["bob", 2],
      ["ada", 1],
    ]);
    expect(chats[0].latest.preview).toBe("bob again");
  }
  expect((await get("/api/inbox/unread-count")).json()).toMatchObject({
    count: 3,
    byAgent: { ada: 1, bob: 2 },
  });
});

test("read-all with upTo marks chat items read and Undo restores them", async () => {
  await callTool(url, tokA, "send_message", { to: ["@or"], body: "one" });
  const upTo = (await get("/api/inbox")).json().chats[0].latest.createdAt;
  const done = await h.app.inject({
    method: "POST",
    url: "/api/inbox/read-all",
    headers: { cookie },
    payload: { upTo },
  });
  expect(done.json().count).toBe(1);
  expect((await get("/api/inbox")).json().chats).toEqual([]);
  const undone = await h.app.inject({
    method: "POST",
    url: "/api/inbox/read-all/undo",
    headers: { cookie },
    payload: { readAt: done.json().readAt },
  });
  expect(undone.json().count).toBe(1);
  expect((await get("/api/inbox")).json().chats).toEqual([expect.objectContaining({ unread: 1 })]);
});

test("GET /api/inbox pages items with a cursor; a bad cursor or limit is a 400, not a 500", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const { row } = await h.app.store.createHumanMessage({
      kind: "system",
      notice: "agent_errored",
      subjectAgentId: (await h.app.store.agentBySlug("ada"))?.id as string,
      fromAgentId: null,
      to: "all",
      body: `m${i}`,
      urgent: false,
    });
    ids.push(row?.id as string);
  }
  const p1 = (await get("/api/inbox?limit=2")).json();
  expect(p1.items.map((i: { preview: string }) => i.preview)).toEqual(["m2", "m1"]);
  const p2 = (await get(`/api/inbox?limit=2&before=${p1.nextCursor}`)).json();
  expect(p2.items.map((i: { preview: string }) => i.preview)).toEqual(["m0"]);
  expect(p2.nextCursor).toBeNull();
  expect(p1.chats).toEqual([]);
  expect("chats" in p2).toBe(false); // only the first page carries the chats
  for (const i of [...p1.items, ...p2.items]) expect(i.kind).toBe("notice"); // never "message" (I1 §6.7)

  const forged = (s: string) => Buffer.from(s).toString("base64url");
  for (const before of [
    "garbage",
    forged("not-a-date|x"),
    forged("2026-02-31T00:00:00.000000Z|x"),
    forged("1|x"),
    forged("0000-01-01T00:00:00.000000Z|x"), // year 0 is no Postgres timestamp
  ]) {
    const bad = await get(`/api/inbox?before=${before}`);
    expect(bad.statusCode, before).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "validation_error", fields: { before: expect.any(String) } },
    });
  }
  for (const limit of ["0", "101", "x"]) {
    const bad = await get(`/api/inbox?limit=${limit}`);
    expect(bad.statusCode, limit).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
  }
});

test("GET /api/messages/:id: 404, pending without recipientEvent, delivered with both events", async () => {
  const missing = await get("/api/messages/nope");
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.code).toBe("message_not_found");

  const out = JSON.parse(
    (await aCalls("toolu_01Y", { to: ["bob"], body: "hello bob" })).content[0]?.text ?? "{}",
  ).results[0];
  // The send woke the hibernated `bob`: its start job, settled, has written the batch, and no session has begun.
  const b = await h.app.runtimes.bySlug("bob");
  await b?.settled();
  expect(
    procOf("bob")
      .sent.flat()
      .map((m) => m.id),
  ).toEqual([out.id]);
  const before = (await get(`/api/messages/${out.id}`)).json();
  expect(before).toEqual({
    id: out.id,
    kind: "message",
    from: "@ada",
    fromKind: "agent",
    to: "@bob",
    state: "pending",
    senderEvent: { agentSlug: "ada", seq: expect.any(Number) },
  });

  procOf("bob").emit(...ev.fullTurn("sess-b"));
  await b?.settled();
  const after = (await get(`/api/messages/${out.id}`)).json();
  expect(after).toMatchObject({
    state: "delivered",
    senderEvent: before.senderEvent,
    recipientEvent: { agentSlug: "bob", seq: expect.any(Number) },
  });
  expect((await get(`/api/messages/${out.id}`, {})).statusCode).toBe(401);
});

test("spec §5.1: a live agent token is refused by the inbox and message lookup routes", async () => {
  const out = JSON.parse(
    (await callTool(url, tokA, "send_message", { to: ["@or"], body: "for or" })).content[0]?.text ??
      "{}",
  ).results[0];
  const bearer = { authorization: `Bearer ${tokA}` };
  for (const path of ["/api/inbox", `/api/messages/${out.id}`]) {
    const r = await get(path, bearer);
    expect(r.statusCode, path).toBe(401);
    expect(r.json()).toEqual({ error: { code: "unauthorized", message: "Not signed in" } });
  }
});

// ---- S8: task items, read state, mark all read with undo, per-user frames ----
const post = (path: string, payload: object = {}, c = cookie) =>
  h.app.inject({ method: "POST", url: path, headers: { cookie: c }, payload });
async function actors() {
  const sam = await signUp(h.app, { handle: "sam" });
  const or = {
    kind: "user" as const,
    userId: (await get("/api/me")).json().id as string,
    handle: "or",
  };
  const ada = await h.app.store.agentBySlug("ada");
  const agent = { kind: "agent" as const, agentId: ada?.id ?? "", slug: "ada" };
  return {
    sam,
    or,
    agent,
    samActor: { kind: "user" as const, userId: sam.user.id, handle: "sam" },
  };
}

test("a mention item: from the agent or the human author, with the task and a deep link to the comment", async () => {
  const { or, agent, samActor } = await actors();
  await h.app.tasks.create(or, { title: "Plan the migration", assignee: "ada" });
  const c1 = await h.app.tasks.comment(agent, "T-1", "@or can you confirm?");
  const c2 = await h.app.tasks.comment(samActor, "T-1", "@or and me");
  const items = (await get("/api/inbox")).json().items as Record<string, unknown>[];
  const mentions = items.filter((i) => i.kind === "mention");
  expect(mentions).toHaveLength(2);
  expect(mentions[1]).toMatchObject({
    kind: "mention",
    read: false,
    from: { kind: "agent", name: "ada" },
    task: { key: "T-1", title: "Plan the migration" },
    link: { kind: "task", key: "T-1", commentId: c1.id },
  });
  expect(mentions[0]).toMatchObject({
    from: { kind: "human", name: "sam" },
    link: { kind: "task", key: "T-1", commentId: c2.id },
  });
});

test("a task event: done from an agent reaches the human creator with fact and a link to the task", async () => {
  const { or, agent } = await actors();
  await h.app.tasks.create(or, { title: "Plan", assignee: "ada" });
  await h.app.tasks.update(agent, "T-1", { status: "done" });
  const item = ((await get("/api/inbox")).json().items as Record<string, unknown>[]).find(
    (i) => i.kind === "task_event",
  );
  expect(item).toMatchObject({
    kind: "task_event",
    fact: "done",
    from: { kind: "factory", name: "factory" },
    task: { key: "T-1", title: "Plan" },
    link: { kind: "task", key: "T-1" },
  });
  expect((item as { link: object }).link).not.toHaveProperty("commentId");
});

test("POST /api/inbox/:id/read marks only the caller's item, idempotently; another user's id is 404", async () => {
  const { or, agent, sam } = await actors();
  await h.app.tasks.create(or, { title: "t" });
  await h.app.tasks.comment(agent, "T-1", "@or @sam hi");
  const mine = ((await get("/api/inbox")).json().items as { id: string }[])[0]?.id as string;
  const theirs = (
    (await get("/api/inbox", { cookie: sam.cookie })).json().items as { id: string }[]
  )[0]?.id as string;
  expect((await post(`/api/inbox/${theirs}/read`)).statusCode).toBe(404);
  expect((await post(`/api/inbox/${theirs}/read`)).json().error.code).toBe("inbox_item_not_found");
  expect((await post(`/api/inbox/${mine}/read`)).statusCode).toBe(200);
  const first = (await h.sql`select read_at from inbox_items where id = ${mine}`)[0]?.read_at;
  expect(first).not.toBeNull();
  await post(`/api/inbox/${mine}/read`);
  expect((await h.sql`select read_at from inbox_items where id = ${mine}`)[0]?.read_at).toEqual(
    first,
  );
  expect(
    (await h.sql`select read_at from inbox_items where id = ${theirs}`)[0]?.read_at,
  ).toBeNull();
  const unread = (await get("/api/inbox?unread=true&limit=5")).json().items as { id: string }[];
  expect(unread.map((i) => i.id)).not.toContain(mine);
  expect((await get("/api/inbox/unread-count")).json()).toMatchObject({
    count: unread.length,
  });
});

test("unread-count byAgent counts unread messages by sending agent only", async () => {
  const { or, agent } = await actors();
  await aCalls("toolu_m1", { to: ["@or"], body: "one" });
  await aCalls("toolu_m2", { to: ["@or"], body: "two" });
  // A mention is a different inbox kind: it must not count toward byAgent.
  await h.app.tasks.create(or, { title: "t" });
  await h.app.tasks.comment(agent, "T-1", "@or @sam hi");
  const r = (await get("/api/inbox/unread-count")).json();
  expect(r.byAgent).toEqual({ ada: 2 });
  expect(r.count).toBeGreaterThanOrEqual(3);
});

test("read-all marks up to upTo (a newer item stays unread) and Undo restores exactly those", async () => {
  const { or, agent, sam } = await actors();
  await h.app.tasks.create(or, { title: "t" });
  for (const n of [1, 2, 3]) await h.app.tasks.comment(agent, "T-1", `@or note ${n}`);
  await h.app.tasks.comment(agent, "T-1", "@sam only sam");
  type Item = { id: string; createdAt: string };
  const page = (await get("/api/inbox")).json().items as Item[];
  const first = page[2] as Item;
  const second = page[1] as Item;
  const third = page[0] as Item;
  // The user read one item by click before: it is not part of the action.
  await post(`/api/inbox/${third.id}/read`);
  const upTo = second.createdAt;
  const r = await post("/api/inbox/read-all", { upTo });
  expect(r.statusCode).toBe(200);
  expect(r.json().count).toBe(2); // first and second; the older-than-upTo unread ones only
  // `third` was read earlier and is newer than upTo; a fourth arrives after the client loaded the list.
  await h.app.tasks.comment(agent, "T-1", "@or late");
  const late = ((await get("/api/inbox?unread=true")).json().items as { id: string }[]).map(
    (i) => i.id,
  );
  expect(late).toHaveLength(1);
  const undo = await post("/api/inbox/read-all/undo", { readAt: r.json().readAt });
  expect(undo.json().count).toBe(2);
  const unread = ((await get("/api/inbox?unread=true")).json().items as { id: string }[]).map(
    (i) => i.id,
  );
  expect(unread.sort()).toEqual([first.id, second.id, ...late].sort());
  expect(unread).not.toContain(third.id); // read by click earlier: Undo leaves it read
  // Another user's items are untouched by both calls.
  const samUnread = (await get("/api/inbox?unread=true", { cookie: sam.cookie })).json()
    .items as unknown[];
  expect(samUnread).toHaveLength(1);
  expect((await post("/api/inbox/read-all", { upTo: "garbage" })).statusCode).toBe(400);
});

test("read-from marks that agent's unread messages up to upTo, idempotent, user-scoped", async () => {
  await aCalls("toolu_r1", { to: ["@or"], body: "one" });
  const sam = (await signUp(h.app, { handle: "sam" })).cookie;
  const upTo = new Date().toISOString();
  const readFrom = (c: string, slug = "ada", body: object = { upTo }) =>
    post(`/api/inbox/read-from/${slug}`, body, c);
  // Another user's call neither marks nor leaks into my items.
  expect((await readFrom(sam)).json().marked).toBe(0);
  expect((await get("/api/inbox/unread-count")).json().byAgent).toEqual({ ada: 1 });
  expect((await readFrom(cookie)).json().marked).toBe(1);
  expect((await readFrom(cookie)).json().marked).toBe(0);
  expect((await get("/api/inbox/unread-count")).json().byAgent).toEqual({});
  expect((await readFrom(cookie, "nobody")).statusCode).toBe(404);
  expect((await readFrom(cookie, "ada", { upTo: "yesterday" })).statusCode).toBe(400);
  // A message after upTo stays unread.
  await new Promise((r) => setTimeout(r, 5));
  await aCalls("toolu_r2", { to: ["@or"], body: "later" });
  expect((await readFrom(cookie)).json().marked).toBe(0);
  expect((await get("/api/inbox/unread-count")).json().byAgent).toEqual({ ada: 1 });
});

test("read-from publishes inbox_changed only when it marked something", async () => {
  await aCalls("toolu_r1", { to: ["@or"], body: "one" });
  const orId = ((await get("/api/me")).json() as { id: string }).id;
  let n = 0;
  h.app.bus.subscribeUser(orId, (m) => m.type === "inbox_changed" && n++);
  const upTo = new Date().toISOString();
  await post("/api/inbox/read-from/ada", { upTo });
  expect(n).toBe(1);
  await post("/api/inbox/read-from/ada", { upTo });
  expect(n).toBe(1);
});

test("read changes reach the reading user's sockets only; new items reach everyone", async () => {
  const { or, agent, sam } = await actors();
  const orId = or.userId;
  const got = { or: 0, sam: 0, all: 0 };
  h.app.bus.subscribeUser(orId, () => got.or++);
  h.app.bus.subscribeUser(sam.user.id, () => got.sam++);
  h.app.bus.subscribeAll((m) => m.type === "inbox_changed" && got.all++);
  await h.app.tasks.create(or, { title: "t" });
  await h.app.tasks.comment(agent, "T-1", "@or @sam hi");
  expect(got.all).toBe(1);
  expect(got.or + got.sam).toBe(0); // new rows publish to every socket, not through the per-user channel
  const mine = ((await get("/api/inbox")).json().items as { id: string }[])[0]?.id as string;
  await post(`/api/inbox/${mine}/read`);
  expect(got).toEqual({ or: 1, sam: 0, all: 1 });
  await post("/api/inbox/read-all", { upTo: "2999-01-01T00:00:00.000Z" });
  expect(got.sam).toBe(0);
});

test.each([
  ["GET", "/api/inbox?unread=true"],
  ["GET", "/api/inbox/unread-count"],
  ["POST", "/api/inbox/x/read"],
  ["POST", "/api/inbox/read-all"],
  ["POST", "/api/inbox/read-all/undo"],
  ["POST", "/api/inbox/read-from/ada"],
] as const)("%s %s: a live agent token gets 401", async (method, path) => {
  const r = await h.app.inject({
    method,
    url: path,
    headers: { authorization: `Bearer ${tokA}` },
    payload: {},
  });
  expect(r.statusCode).toBe(401);
});

test("GET /api/inbox/:id: the owner's item equals the list entry; another user's or unknown id is 404; static routes still win", async () => {
  const { or, agent, sam } = await actors();
  await h.app.tasks.create(or, { title: "t" });
  await h.app.tasks.comment(agent, "T-1", "@or @sam hi");
  const entries = (await get("/api/inbox")).json().items as { id: string }[];
  const mine = entries[0] as { id: string };
  const theirs = (
    (await get("/api/inbox", { cookie: sam.cookie })).json().items as { id: string }[]
  )[0]?.id as string;
  const r = await get(`/api/inbox/${mine.id}`);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ item: mine });
  const other = await get(`/api/inbox/${theirs}`);
  expect(other.statusCode).toBe(404);
  expect(other.json().error.code).toBe("inbox_item_not_found");
  expect((await get("/api/inbox/nope")).statusCode).toBe(404);
  expect((await get("/api/inbox/unread-count")).json()).toHaveProperty("count");
  expect((await get(`/api/inbox/${mine.id}`, {})).statusCode).toBe(401);
});
