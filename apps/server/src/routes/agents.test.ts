import { afterAll, beforeAll, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seed();
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

test("start failure is 503 and the message stays queued", async () => {
  const t2 = await makeTestApp({
    harnessDriver: new FakeDriver(),
    env: { CLAUDE_CODE_OAUTH_TOKEN: "" },
  });
  try {
    await t2.seed();
    const c2 = (await t2.signUpUser({ handle: "or2" })).cookie;
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/agents/dev/messages",
      headers: { cookie: c2 },
      payload: { body: "hi", urgent: false },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: "agent_start_failed", message: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents" },
    });
    const detail = (
      await t2.app.inject({ method: "GET", url: "/api/agents/dev", headers: { cookie: c2 } })
    ).json();
    expect(detail.queue.map((q: { body: string }) => q.body)).toEqual(["hi"]);
    expect(detail.agent).toMatchObject({
      status: "errored",
      lastError: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents",
    });
  } finally {
    await t2.close();
  }
});
