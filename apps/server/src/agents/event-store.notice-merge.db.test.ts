import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";
import { notices, parseConfigNotice } from "./notices.ts";
import { insertAgent } from "./testing/rows.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  for (const [id, handle] of [
    ["m1", "lead"],
    ["r1", "dev"],
    ["r2", "qa"],
    ["x1", "hr"],
  ] as const)
    await insertAgent(t.sql, { id, handle });
});
afterAll(() => t.close());

const report = (
  toAgentId: string,
  subjectAgentId: string,
  by: string,
  lines: string[],
  r = "<@dev00000>",
) =>
  store.createNotice({
    toAgentId,
    notice: "report_config_changed",
    body: notices.reportConfigChanged({ by, report: r, lines }),
    subjectAgentId,
  });
const pendingReports = (toAgentId: string) =>
  t.sql<{ id: string; body: string; subject_agent_id: string | null }[]>`
    select id, body, subject_agent_id from messages
    where to_id = ${toAgentId} and notice = 'report_config_changed' and state = 'pending'
    order by created_at`;

test("two notices for the same manager and report make one row with the sorted union of lines", async () => {
  const a = await report("m1", "r1", "<@hr000000>", ["b change", "a change"]);
  const b = await report("m1", "r1", "<@qa000000>", ["c change", "a change"]);
  expect(b.id).toBe(a.id);
  const rows = await pendingReports("m1");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.subject_agent_id).toBe("r1");
  // The newest header names the latest actor.
  expect(rows[0]?.body).toBe(
    "<@qa000000> changed <@dev00000>'s configuration:\n- a change\n- b change\n- c change",
  );
});

test("a different report of the same manager gets its own row", async () => {
  await report("m1", "r2", "<@hr000000>", ["q change"], "<@qa000000>");
  const rows = await pendingReports("m1");
  expect(rows.map((r) => r.subject_agent_id).sort()).toEqual(["r1", "r2"]);
  const qa = rows.find((r) => r.subject_agent_id === "r2");
  expect(qa?.body).toBe("<@hr000000> changed <@qa000000>'s configuration:\n- q change");
});

test("concurrent merges lose no line and make no second row", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `concurrent ${String(i).padStart(2, "0")}`);
  await Promise.all(lines.map((l) => report("r2", "x1", "@hr", [l], "hr")));
  const rows = await pendingReports("r2");
  expect(rows).toHaveLength(1);
  expect(parseConfigNotice(rows[0]?.body ?? "")).toEqual(lines);
});

test("concurrent merges for two reports of one manager keep one row each with all lines", async () => {
  const lines = ["l1", "l2", "l3", "l4"];
  await Promise.all(
    lines.flatMap((l) => [
      report("x1", "r1", "@hr", [l], "dev"),
      report("x1", "r2", "@hr", [l], "qa"),
    ]),
  );
  const rows = await pendingReports("x1");
  expect(rows).toHaveLength(2);
  for (const r of rows) expect(parseConfigNotice(r.body)).toEqual(lines);
  expect(rows.map((r) => r.subject_agent_id).sort()).toEqual(["r1", "r2"]);
});

test("a delivered notice is never merged into: the next one is a new row", async () => {
  const first = await report("x1", "r1", "@hr", ["one"]);
  await t.sql`update messages set state = 'delivered' where id = ${first.id}`;
  const second = await report("x1", "r1", "@hr", ["two"]);
  expect(second.id).not.toBe(first.id);
  expect(parseConfigNotice(second.body)).toEqual(["two"]);
});

test("config_changed still merges per agent, whatever the subject", async () => {
  const a = await store.createNotice({
    toAgentId: "r1",
    notice: "config_changed",
    body: notices.configChanged(["b"]),
  });
  const b = await store.createNotice({
    toAgentId: "r1",
    notice: "config_changed",
    body: notices.configChanged(["a"]),
  });
  expect(b.id).toBe(a.id);
  expect(b.body).toBe("Your configuration changed:\n- a\n- b");
});
