import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seedAgent();
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const req = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });

test("requires a signed-in user", async () => {
  expect((await t.app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);
});

test("auth runs before validation: signed-out bad input is 401, not 400", async () => {
  const post = await t.app.inject({
    method: "POST",
    url: "/api/agents/dev/messages",
    payload: { body: 42 },
  });
  expect(post.statusCode).toBe(401);
  expect(post.json().error.code).toBe("unauthorized");
  const get = await t.app.inject({ method: "GET", url: "/api/agents/dev/events?limit=abc" });
  expect(get.statusCode).toBe(401);
  expect(get.json().error.code).toBe("unauthorized");
});

test("list and detail", async () => {
  const list = await req("GET", "/api/agents");
  expect(list.json()).toEqual({
    agents: [expect.objectContaining({ slug: "dev", status: "hibernated", runtime: "local" })],
  });
  expect((await req("GET", "/api/agents/dev")).json()).toEqual({
    agent: expect.objectContaining({ slug: "dev" }),
    queue: [],
    lastSeq: 0,
  });
  expect((await req("GET", "/api/agents/nope")).json()).toEqual({
    error: { code: "agent_not_found", message: "No agent named nope" },
  });
});

test("send, then read events back; interrupt 409 while idle, 202 with an open turn", async () => {
  const sent = await req("POST", "/api/agents/dev/messages", { body: "hello", urgent: false });
  expect(sent.statusCode).toBe(202);
  expect(sent.json().item).toMatchObject({ kind: "message", body: "hello", from: "@or" });
  driver.last.emit(ev.session(), ev.turn(), ev.text("hi"), ev.usage(), ev.end());
  const rt = await t.app.runtimes.bySlug("dev");
  await rt?.settled();
  const page = (await req("GET", "/api/agents/dev/events")).json();
  expect(page.events.map((e: { event: { type: string } }) => e.event.type)).toEqual([
    "process_started",
    "message_in",
    "session_started",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  expect(page.hasMore).toEqual({ before: false, after: false });
  expect(
    (await req("GET", "/api/agents/dev/events?around=3&limit=3"))
      .json()
      .events.map((e: { seq: number }) => e.seq),
  ).toEqual([2, 3, 4]);
  expect((await req("GET", "/api/agents/dev/events?around=999")).statusCode).toBe(404);
  const idle = await req("POST", "/api/agents/dev/interrupt");
  expect(idle.statusCode).toBe(409);
  expect(idle.json().error.code).toBe("no_open_turn");
  driver.last.emit(ev.turn());
  await rt?.settled();
  expect((await req("POST", "/api/agents/dev/interrupt")).statusCode).toBe(202);
});

test("history query edge cases", async () => {
  const both = await req("GET", "/api/agents/dev/events?before=3&around=3");
  expect(both.statusCode).toBe(400);
  expect(both.json().error.code).toBe("validation_error");
  const last = (await req("GET", "/api/agents/dev")).json().lastSeq as number;
  const far = (await req("GET", `/api/agents/dev/events?before=${last + 1000}&limit=2`)).json();
  expect(far.events.map((e: { seq: number }) => e.seq)).toEqual([last - 1, last]);
  expect(far.hasMore).toEqual({ before: true, after: false });
  expect((await req("GET", "/api/agents/dev/events?limit=501")).statusCode).toBe(400);
  expect((await req("GET", "/api/agents/dev/events?before=3&limit=2")).json().events).toHaveLength(
    2,
  );
});

test("compact is accepted and queued; validation errors are 400", async () => {
  const c = await req("POST", "/api/agents/dev/compact", { focus: "keep the API" });
  expect(c.statusCode).toBe(202);
  expect(c.json().item).toMatchObject({ kind: "compact", focus: "keep the API" });
  expect((await req("POST", "/api/agents/dev/compact", {})).statusCode).toBe(202);
  expect(
    (await req("POST", "/api/agents/dev/messages", { body: "  ", urgent: false })).statusCode,
  ).toBe(400);
  expect(
    (await req("POST", "/api/agents/dev/messages", { body: "x".repeat(65_537), urgent: false }))
      .statusCode,
  ).toBe(400);
});

test("start failure is 503 with the fix text and the message stays queued", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent({ config: { secrets: ["GH_TOKEN"] } });
    const c2 = (await t2.signUpUser({ handle: "or2" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/agents/dev/messages",
      headers: { cookie: c2 },
      payload: { body: "hi", urgent: false },
    });
    const message = "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.";
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "agent_start_failed", message } });
    const detail = (
      await t2.app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie: c2 } })
    ).json();
    expect(detail.queue.map((q: { body: string }) => q.body)).toEqual(["hi"]);
    expect(detail.agent).toMatchObject({ status: "errored", lastError: message });
  } finally {
    await t2.close();
  }
});

test("an archived agent refuses messages, compact and interrupt with 409 agent_archived", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    await t2.seedAgent();
    await t2.sql`update agents set archived_at = now() where slug = 'dev'`;
    const c2 = (await t2.signUpUser({ handle: "or3" })).cookie;
    for (const [url, payload] of [
      ["/api/agents/dev/messages", { body: "hi", urgent: false }],
      ["/api/agents/dev/compact", {}],
      ["/api/agents/dev/interrupt", undefined],
    ] as const) {
      const res = await t2.app.inject({
        method: "POST",
        url,
        headers: { cookie: c2 },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("agent_archived");
    }
    const stored = await t2.sql`select count(*)::int as n from messages`;
    expect(stored[0]?.n).toBe(0);
  } finally {
    await t2.close();
  }
});

test("agent management routes: create, patch, resync, archive, unarchive, list filter, bad slugs", async () => {
  const t2 = await makeTestApp({ harnessDriver: new FakeDriver() });
  try {
    const c2 = (await t2.signUpUser({ handle: "or4" })).cookie;
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      t2.app.inject({ method, url, headers: { cookie: c2 }, ...(payload ? { payload } : {}) });
    const tdir = path.join(t2.factoryHome, "templates/lead");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      path.join(tdir, "template.yaml"),
      "name: lead\ndisplay_name: Lead\nruntime: local\n",
    );
    writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
    const credId = randomUUID();
    await t2.db.insert(schema.credentials).values({
      id: credId,
      name: "work",
      kind: "oauth_token",
      valueEnc: t2.app.vault.seal("tok", `credentials:${credId}`),
    });
    const body = {
      template: "lead",
      slug: "boss",
      displayName: "Boss",
      description: "",
      reportsTo: null,
      credential: "work",
    };

    const created = await call("POST", "/api/agents", body);
    expect(created.statusCode).toBe(201);
    expect(created.json().agent).toMatchObject({ slug: "boss", credential: "work" });
    const bad = await call("POST", "/api/agents", { ...body, slug: "Bad Slug" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toHaveProperty("slug");
    expect((await call("POST", "/api/agents", body)).json().error.code).toBe("slug_taken");

    const patched = await call("PATCH", "/api/agents/boss", { description: "the boss" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().agent.description).toBe("the boss");
    const rs = await call("POST", "/api/agents/boss/resync");
    expect(rs.statusCode).toBe(200);
    expect(rs.json().agent.slug).toBe("boss");

    expect((await call("POST", "/api/agents/boss/archive")).statusCode).toBe(200);
    expect((await call("POST", "/api/agents/boss/resync")).json().error.code).toBe(
      "agent_archived",
    );
    expect(
      (await call("GET", "/api/agents?archived=only"))
        .json()
        .agents.map((a: { slug: string }) => a.slug),
    ).toEqual(["boss"]);
    expect((await call("GET", "/api/agents")).json().agents).toEqual([]);
    expect((await call("POST", "/api/agents/boss/unarchive")).json().agent.archivedAt).toBeNull();

    for (const [m, url] of [
      ["GET", "/api/agents/..%2F..%2Fetc"],
      ["GET", "/api/agents/..%2F..%2Fetc/events"],
      ["PATCH", "/api/agents/..%2F..%2Fetc"],
      ["POST", "/api/agents/..%2F..%2Fetc/resync"],
      ["POST", "/api/agents/..%2F..%2Fetc/archive"],
      ["POST", "/api/agents/..%2F..%2Fetc/unarchive"],
      ["POST", "/api/agents/..%2F..%2Fetc/messages"],
      ["POST", "/api/agents/..%2F..%2Fetc/compact"],
      ["POST", "/api/agents/..%2F..%2Fetc/interrupt"],
    ] as const) {
      const res = await call(m, url, m === "GET" ? undefined : { body: "x", description: "x" });
      expect(res.statusCode, `${m} ${url}`).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  } finally {
    await t2.close();
  }
});
