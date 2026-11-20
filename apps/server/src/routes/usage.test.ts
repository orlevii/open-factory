import { schema } from "@open-factory/db";
import type {
  AgentsUsage,
  AgentUsage,
  CredentialsUsage,
  DailyUsage,
  TaskDetail,
} from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { insertTurn } from "../agents/testing/rows.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** S10 §7, §13, AC1, AC8: the usage REST surface returns the service's numbers, human session only. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let leadId: string;
const clock = new Date("2026-11-20T10:00:00Z");

beforeEach(async () => {
  h = await makeTestApp({
    harnessDriver: new FakeDriver(),
    clock: () => clock,
    env: { FACTORY_TIMEZONE: "UTC" },
  });
  or = await signUp(h.app, { handle: "or" });
  leadId = (await h.seedAgent({ slug: "lead" })).id;
});
afterEach(() => h.close());

const get = (url: string) => h.app.inject({ method: "GET", url, headers: { cookie: or.cookie } });

const seedTurns = async (taskId?: string) => {
  await insertTurn(h.sql, {
    id: "u1",
    agentId: leadId,
    startedAt: new Date("2026-11-20T08:00:00Z"),
    costUsd: 1.5,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheReadTokens: 5,
    model: "opus",
    ...(taskId ? { taskId } : {}),
  });
  await insertTurn(h.sql, {
    id: "u2",
    agentId: leadId,
    startedAt: new Date("2026-11-18T08:00:00Z"),
    costUsd: 0.25,
    inputTokens: 10,
    outputTokens: 5,
    model: "opus",
  });
};
const totals = (costUsd: number, turns: number, i: number, o: number, w: number, r: number) => ({
  costUsd,
  turns,
  inputTokens: i,
  outputTokens: o,
  cacheWriteTokens: w,
  cacheReadTokens: r,
});

test("GET /api/usage/daily returns the zero-filled calendar days", async () => {
  await seedTurns();
  const r = await get("/api/usage/daily?days=30");
  expect(r.statusCode).toBe(200);
  const body = r.json() as DailyUsage;
  expect(body.timezone).toBe("UTC");
  expect(body.days).toHaveLength(30);
  expect(body.days.at(-1)).toEqual({ date: "2026-11-20", ...totals(1.5, 1, 100, 50, 10, 5) });
  expect(body.days.find((d) => d.date === "2026-11-18")).toMatchObject({ costUsd: 0.25 });
  expect(body.days.find((d) => d.date === "2026-11-19")).toMatchObject({ costUsd: 0, turns: 0 });
});

test("GET /api/usage/agents returns own, spawned and total per agent", async () => {
  await seedTurns();
  const r = await get("/api/usage/agents?days=7");
  expect(r.statusCode).toBe(200);
  const lead = (r.json() as AgentsUsage).agents.find((a) => a.slug === "lead");
  expect(lead).toMatchObject({
    kind: "persistent",
    archived: false,
    own: totals(1.75, 2, 110, 55, 10, 5),
    total: totals(1.75, 2, 110, 55, 10, 5),
  });
});

test("GET /api/usage/agents?window=rolling is the tree's rolling 7 days", async () => {
  await insertTurn(h.sql, {
    id: "r1",
    agentId: leadId,
    startedAt: new Date("2026-11-13T11:00:00Z"), // inside rolling 7d, before the calendar window (Nov 14)
    costUsd: 2,
  });
  const cal = (await get("/api/usage/agents?days=7")).json() as AgentsUsage;
  const roll = (await get("/api/usage/agents?days=7&window=rolling")).json() as AgentsUsage;
  expect(cal.agents.find((a) => a.slug === "lead")?.total.costUsd).toBe(0);
  expect(roll.agents.find((a) => a.slug === "lead")?.total.costUsd).toBe(2);
});

test("window=rolling with days omitted is the rolling 7 days", async () => {
  await insertTurn(h.sql, {
    id: "r1",
    agentId: leadId,
    startedAt: new Date("2026-11-13T11:00:00Z"),
    costUsd: 2,
  });
  // in the default 30 calendar days, not in the rolling 7
  await insertTurn(h.sql, {
    id: "r2",
    agentId: leadId,
    startedAt: new Date("2026-11-01T11:00:00Z"),
    costUsd: 4,
  });
  const r = await get("/api/usage/agents?window=rolling");
  expect(r.statusCode).toBe(200);
  expect((r.json() as AgentsUsage).agents.find((a) => a.slug === "lead")?.total.costUsd).toBe(2);
});

test.each([
  "/api/usage/agents?window=bogus",
  "/api/usage/agents?window=rolling&days=30",
  "/api/usage/agents?window=rolling&days=90",
])("%s is 400 invalid_window", async (url) => {
  const r = await get(url);
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("invalid_window");
});

test("the days follow FACTORY_TIMEZONE, not UTC", async () => {
  await seedTurns();
  // 05:00 on Nov 20 in Tokyo, still Nov 19 in UTC
  await insertTurn(h.sql, {
    id: "tz1",
    agentId: leadId,
    startedAt: new Date("2026-11-19T20:00:00Z"),
    costUsd: 0.5,
  });
  await h.app.close();
  const tokyo = await h.reopen({
    harnessDriver: new FakeDriver(),
    clock: () => clock,
    env: { FACTORY_TIMEZONE: "Asia/Tokyo" },
  });
  const body = (
    await tokyo.app.inject({
      method: "GET",
      url: "/api/usage/daily?days=7",
      headers: { cookie: or.cookie },
    })
  ).json() as DailyUsage;
  expect(body.timezone).toBe("Asia/Tokyo");
  expect(body.days.at(-1)).toMatchObject({ date: "2026-11-20", costUsd: 2, turns: 2 });
  expect(body.days.find((d) => d.date === "2026-11-19")).toMatchObject({ costUsd: 0, turns: 0 });
});

test("GET /api/usage/credentials returns totals, top agents and a null rate limit", async () => {
  await seedTurns();
  const [cred] = await h.db.select().from(schema.credentials);
  await h.sql`update turns set credential_id = ${cred?.id ?? ""} where id = 'u1'`;
  const r = await get("/api/usage/credentials?days=30");
  expect(r.statusCode).toBe(200);
  const body = r.json() as CredentialsUsage;
  const row = body.credentials.find((c) => c.name === cred?.name);
  expect(row).toMatchObject({
    totals: totals(1.5, 1, 100, 50, 10, 5),
    agents: [{ slug: "lead", costUsd: 1.5 }],
    rateLimit: null,
  });
  expect(body.unattributed).toEqual(totals(0.25, 1, 10, 5, 0, 0));
});

test("GET /api/agents/:slug/usage returns the agent page", async () => {
  await seedTurns();
  const r = await get("/api/agents/lead/usage?days=30");
  expect(r.statusCode).toBe(200);
  const body = r.json() as AgentUsage;
  expect(body.agent).toEqual({ slug: "lead", displayName: expect.any(String), kind: "persistent" });
  expect(body.total).toEqual(totals(1.75, 2, 110, 55, 10, 5));
  expect(body.daily).toHaveLength(30);
  expect(body.byModel).toEqual([{ model: "opus", ...totals(1.75, 2, 110, 55, 10, 5) }]);
});

test.each([
  "/api/usage/daily?days=14",
  "/api/usage/agents?days=14",
  "/api/usage/credentials?days=14",
  "/api/agents/lead/usage?days=14",
])("%s is 400 invalid_days", async (url) => {
  const r = await get(url);
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("invalid_days");
});

test("an unknown agent slug is 404", async () => {
  expect((await get("/api/agents/nobody/usage?days=30")).statusCode).toBe(404);
});

test("GET /api/tasks/:key has usage: null without turns, the closed turns' sum with them", async () => {
  const created = await h.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie: or.cookie },
    payload: { title: "Ship" },
  });
  expect(created.statusCode).toBe(201);
  expect((await get("/api/tasks/T-1")).json().usage).toBeNull();
  const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.number, 1));
  await seedTurns(task?.id);
  const t = (await get("/api/tasks/T-1")).json() as TaskDetail;
  expect(t.usage).toEqual({ costUsd: 1.5, turns: 1 });
});

test("GET /api/credentials carries rateLimit, null with no data", async () => {
  const r = await get("/api/credentials");
  expect(r.statusCode).toBe(200);
  const [c] = r.json().credentials;
  expect(c.rateLimit).toBeNull();
  expect(c.pausedUntil).toBeUndefined();
});

test("GET /api/credentials carries the observed rate limit and a live pause only while in the future", async () => {
  const [cred] = await h.db.select().from(schema.credentials);
  await h.db
    .update(schema.credentials)
    .set({
      rlStatus: "allowed_warning",
      rlType: null,
      rlUtilization: 0.5,
      rlResetsAt: new Date("2026-11-20T12:00:00Z"),
      rlObservedAt: new Date("2026-11-20T09:00:00Z"),
      rateLimitedUntil: new Date("2026-11-20T11:00:00Z"),
      rateLimitExact: false,
    })
    .where(eq(schema.credentials.id, cred?.id ?? ""));
  const live = (await get("/api/credentials")).json().credentials[0];
  expect(live.rateLimit).toEqual({
    status: "allowed_warning",
    type: null,
    utilization: 0.5,
    resetsAt: "2026-11-20T12:00:00.000Z",
    observedAt: "2026-11-20T09:00:00.000Z",
  });
  expect(live.pausedUntil).toBe("2026-11-20T11:00:00.000Z");
  expect(live.pauseExact).toBe(false);
  await h.db
    .update(schema.credentials)
    .set({ rateLimitedUntil: new Date("2026-11-20T09:30:00Z") })
    .where(eq(schema.credentials.id, cred?.id ?? ""));
  const past = (await get("/api/credentials")).json().credentials[0];
  expect(past.pausedUntil).toBeUndefined();
});

test.each([
  "/api/usage/daily?days=30",
  "/api/usage/agents?days=30",
  "/api/usage/credentials?days=30",
  "/api/agents/lead/usage?days=30",
])("%s needs a human session: no auth and a live agent token both get 401", async (url) => {
  expect((await h.app.inject({ method: "GET", url })).statusCode).toBe(401);
  const { token } = h.app.agentTokens.mint(leadId);
  const agent = await h.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(agent.statusCode).toBe(401);
});
