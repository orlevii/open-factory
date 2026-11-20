import type { ScheduleItem, ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let frames: ServerMessage[];
const ids: Record<string, string> = {};
const clock = new Date("2026-11-20T10:00:00Z");

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver(), clock: () => clock });
  or = await signUp(h.app, { handle: "or" });
  for (const slug of ["ceo", "dev"]) ids[slug] = (await h.seedAgent({ slug })).id;
  frames = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
});
afterEach(() => h.close());

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  h.app.inject({ method, url, headers: { cookie: or.cookie }, ...(payload ? { payload } : {}) });
const weekday = { target: "ceo", cron: "0 9 * * 1-5", timezone: "Europe/Berlin", body: "Review" };
const create = async (over: object = {}) => {
  const r = await call("POST", "/api/schedules", { ...weekday, ...over });
  expect(r.statusCode).toBe(201);
  return r.json().schedule as ScheduleItem;
};
const changes = () => frames.filter((f) => f.type === "schedules_changed").length;

test.each([
  ["GET", "/api/schedules"],
  ["POST", "/api/schedules"],
  ["GET", "/api/schedules/S-1"],
  ["PATCH", "/api/schedules/S-1"],
  ["POST", "/api/schedules/S-1/pause"],
  ["POST", "/api/schedules/S-1/resume"],
  ["DELETE", "/api/schedules/S-1"],
  ["POST", "/api/schedules/S-1/restore"],
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

test("POST creates (201) as the human and publishes schedules_changed once", async () => {
  const s = await create();
  expect(s).toMatchObject({
    key: expect.stringMatching(/^S-\d+$/),
    cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    nextRunAt: "2026-11-23T08:00:00.000Z",
    createdBy: { kind: "user", handle: "or" },
    state: "active",
  });
  expect(changes()).toBe(1);
});

test("invalid input is 400 invalid_schedule with the sentence and its field; unknown key is 404", async () => {
  const bad = await call("POST", "/api/schedules", { ...weekday, at: "2026-12-01T09:00" });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatchObject({
    code: "invalid_schedule",
    message: "Pass either cron or at.",
  });
  const past = await call("POST", "/api/schedules", {
    target: "ceo",
    at: "2026-11-01T09:00",
    timezone: "UTC",
    body: "x",
  });
  expect(past.json().error).toMatchObject({
    code: "invalid_schedule",
    message: "That time has passed.",
    fields: { at: "That time has passed." },
  });
  const sentence = await call("POST", "/api/schedules", { ...weekday, cron: "@daily" });
  expect(sentence.statusCode).toBe(400);
  expect((await call("GET", "/api/schedules/S-999")).statusCode).toBe(404);
  expect((await call("GET", "/api/schedules/S-999")).json().error.code).toBe("schedule_not_found");
});

test("edit, pause, resume, delete and restore with their conflict codes; every change publishes once", async () => {
  const s = await create();
  frames.length = 0;
  const edit = await call("PATCH", `/api/schedules/${s.key}`, { body: "New" });
  expect(edit.json().schedule).toMatchObject({ body: "New" });
  expect((await call("POST", `/api/schedules/${s.key}/resume`)).json().error.code).toBe(
    "not_paused",
  );
  expect((await call("POST", `/api/schedules/${s.key}/pause`)).json().schedule.state).toBe(
    "paused",
  );
  expect((await call("POST", `/api/schedules/${s.key}/pause`)).statusCode).toBe(409);
  expect((await call("POST", `/api/schedules/${s.key}/resume`)).json().schedule.state).toBe(
    "active",
  );
  const del = await call("DELETE", `/api/schedules/${s.key}`);
  expect(del.json().schedule.deleted).toBe(true);
  expect(changes()).toBe(4);
  expect((await call("PATCH", `/api/schedules/${s.key}`, { body: "x" })).statusCode).toBe(404);
  // a deleted schedule is still readable (the badge link offers Restore)
  expect((await call("GET", `/api/schedules/${s.key}`)).json().schedule.deleted).toBe(true);
  expect(
    (await call("POST", `/api/schedules/${s.key}/restore`)).json().schedule.deleted,
  ).toBeUndefined();
});

test("restore of a schedule whose target ended is 409 target_ended", async () => {
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.ceo as string} where slug = 'dev'`;
  const s = await create({ target: "dev" });
  await call("DELETE", `/api/schedules/${s.key}`);
  await h.sql`update agents set terminated_at = now(), terminated_by = '@or' where slug = 'dev'`;
  const r = await call("POST", `/api/schedules/${s.key}/restore`);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatchObject({ code: "target_ended", message: "@dev was terminated." });
});

test("list: ordered active, paused, then done; ?target and ?done", async () => {
  const later = await create({ cron: "0 10 * * *" });
  const sooner = await create({ cron: "0 9 * * *", target: "dev" });
  const paused = await create({ cron: "0 8 * * *" });
  await call("POST", `/api/schedules/${paused.key}/pause`);
  const once = await create({ cron: undefined, at: "2026-11-21T09:00", timezone: "UTC" });
  await h.sql`update schedules set next_run_at = null, last_fired_at = '2026-11-21T09:00:00Z' where number = ${Number(once.key.slice(2))}`;
  const keys = async (q = "") =>
    ((await call("GET", `/api/schedules${q}`)).json().schedules as ScheduleItem[]).map(
      (x) => x.key,
    );
  expect(await keys()).toEqual([sooner.key, later.key, paused.key]);
  expect(await keys("?done=true")).toEqual([sooner.key, later.key, paused.key, once.key]);
  expect(await keys("?target=dev")).toEqual([sooner.key]);
});

test("the agent summary counts schedules targeting it that are neither deleted nor done", async () => {
  const a = await create();
  await create();
  const d = await create({ cron: undefined, at: "2026-11-21T09:00", timezone: "UTC" });
  await h.sql`update schedules set next_run_at = null where number = ${Number(d.key.slice(2))}`;
  const gone = await create();
  await call("DELETE", `/api/schedules/${gone.key}`);
  void a;
  const summary = (await call("GET", "/api/agents/ceo")).json();
  expect(summary.agent.scheduleCount).toBe(2);
  expect(summary.agent.crons).toEqual([]);
});
