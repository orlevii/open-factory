import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../../test/helpers.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let userId: string;
const ids: Record<string, string> = {};
const tok: Record<string, string> = {};
let clock = new Date("2026-11-20T10:00:00Z");

beforeEach(async () => {
  clock = new Date("2026-11-20T10:00:00Z");
  h = await makeTestApp({
    harnessDriver: new FakeDriver(),
    env: { FACTORY_TIMEZONE: "Europe/Berlin" },
    clock: () => clock,
  });
  url = `http://127.0.0.1:${h.app.agentListener.port}`;
  userId = (await signUp(h.app, { handle: "or" })).user.id;
  for (const slug of ["lead", "dev", "qa"]) {
    ids[slug] = (await h.seedAgent({ slug })).id;
    tok[slug] = h.app.agentTokens.mint(ids[slug] as string).token;
  }
  // a spawned agent
  ids.kid = (await h.seedAgent({ slug: "kid" })).id;
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${ids.lead as string} where slug = 'kid'`;
  tok.kid = h.app.agentTokens.mint(ids.kid as string).token;
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
  ).map((t) => t.name);
const SCHED = ["schedule_message", "list_schedules", "cancel_schedule"];

test("persistent agents list the three schedule tools; a spawned agent lists none and can't call them", async () => {
  for (const t of SCHED) expect(await names("dev")).toContain(t);
  for (const t of SCHED) expect(await names("kid")).not.toContain(t);
  const r = await mcpCall(url, tok.kid as string, "tools/call", {
    name: "schedule_message",
    arguments: { body: "x", cron: "0 9 * * *" },
  });
  expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
});

test("schedule_message defaults to the caller, the factory zone and a note for a recurring self-schedule", async () => {
  const r = await call("dev", "schedule_message", { body: "Weekly review", cron: "0 9 * * 1-5" });
  expect(r.json).toEqual({
    id: expect.stringMatching(/^S-\d+$/),
    to: "dev",
    cron: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    next_run: "2026-11-23T09:00:00+01:00",
    note: "You will be woken at each run; cancel it with cancel_schedule when it is no longer needed.",
  });
  const [row] =
    await h.sql`select created_by_agent_id, body_author_agent_id, target_agent_id from schedules`;
  expect(row).toEqual({
    created_by_agent_id: ids.dev,
    body_author_agent_id: ids.dev,
    target_agent_id: ids.dev,
  });
});

test("at, to and me; an errored target gets its note; identity never comes from arguments", async () => {
  const a = await call("dev", "schedule_message", {
    body: "later",
    at: "2026-12-01T09:00",
    to: "qa",
    created_by: "lead",
  });
  expect(a.json).toMatchObject({
    to: "qa",
    at: "2026-12-01T09:00:00+01:00",
    timezone: "Europe/Berlin",
  });
  expect(a.json.note).toBeUndefined();
  const me = await call("dev", "schedule_message", { body: "x", at: "2026-12-02T09:00", to: "me" });
  expect(me.json.to).toBe("dev");
  await h.sql`update agents set status = 'errored' where slug = 'qa'`;
  const e = await call("dev", "schedule_message", { body: "x", at: "2026-12-03T09:00", to: "qa" });
  expect(e.json.note).toBe("@qa is errored; it will see this when a human restarts it.");
  const rows = await h.sql`select created_by_agent_id from schedules`;
  expect(new Set(rows.map((r) => r.created_by_agent_id))).toEqual(new Set([ids.dev]));
});

test("service refusals (the 15-minute floor, both-or-neither, bad cron) come back as tool errors with sentences", async () => {
  const floor = await call("dev", "schedule_message", { body: "x", cron: "*/5 * * * *" });
  expect(floor).toMatchObject({
    err: true,
    text: "Schedules can't fire more often than every 15 minutes. For a short loop inside this session, use CronCreate.",
  });
  expect((await call("dev", "schedule_message", { body: "x" })).text).toBe(
    "Pass either cron or at.",
  );
  expect((await call("dev", "schedule_message", { body: "x", cron: "@daily" })).err).toBe(true);
});

test("list_schedules shows what the caller created and what targets it; cancel_schedule follows the rules", async () => {
  const mine = (await call("dev", "schedule_message", { body: "mine", cron: "0 9 * * *" })).json.id;
  const human = (
    await h.app.schedules.create(
      { userId },
      { target: "dev", cron: "0 8 * * *", timezone: "UTC", body: "from a human" },
    )
  ).item.key;
  await call("qa", "schedule_message", { body: "elsewhere", cron: "0 9 * * *" });
  const list = (await call("dev", "list_schedules", {})).json as {
    id: string;
    yours: boolean;
    body: string;
    by: string;
  }[];
  expect(list.map((x) => [x.id, x.yours, x.by])).toEqual([
    [human, false, "@or"],
    [mine, true, "dev"],
  ]);
  const no = await call("dev", "cancel_schedule", { id: human });
  expect(no).toMatchObject({
    err: true,
    text: `${human} was created by @or; only its creator or a human can cancel it.`,
  });
  expect((await call("dev", "cancel_schedule", { id: mine.toLowerCase() })).json).toEqual({
    id: mine,
    status: "cancelled",
  });
  expect((await call("dev", "cancel_schedule", { id: mine })).text).toBe(
    `There is no schedule ${mine}.`,
  );
});
