import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";
import { insertAgent } from "./testing/rows.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  await insertAgent(t.sql, { id: "a1", slug: "dev" });
  await insertAgent(t.sql, { id: "a2", slug: "b" });
});
afterAll(() => t.close());

test("append assigns seq 1..n per agent, independently", async () => {
  const e1 = await store.append("a1", null, { type: "process_started", resumed: false });
  const e2 = await store.append("a1", null, { type: "turn_started" });
  const f1 = await store.append("a2", null, { type: "turn_started" });
  expect([e1.seq, e2.seq, f1.seq]).toEqual([1, 2, 1]);
  expect(e1).toMatchObject({
    agentSlug: "dev",
    turnId: null,
    event: { type: "process_started", resumed: false },
  });
  expect(await store.lastSeq("a1")).toBe(2);
});

test("append caps oversized strings and returns the truncated map", async () => {
  const e = await store.append("a2", null, { type: "assistant_text", text: "x".repeat(70_000) });
  expect(e.truncated).toEqual({ text: 70_000 });
  // The returned DTO (what goes out live) carries the capped payload, same as replay (spec 6.4).
  const text = (e.event as { text: string }).text;
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
  expect(text.length).toBeLessThan(70_000);
  const [row] = await store.after("a2", e.seq - 1, 1);
  expect(row?.truncated).toEqual({ text: 70_000 });
  expect(row?.event).toEqual(e.event);
});

test("page: newest, before, around, missing around", async () => {
  for (let i = 0; i < 10; i++)
    await store.append("a1", null, { type: "assistant_text", text: `n${i}` });
  const newest = await store.page("a1", { limit: 3 });
  expect(newest?.events.map((e) => e.seq)).toEqual([10, 11, 12]);
  expect(newest?.hasMore).toEqual({ before: true, after: false });
  const before = await store.page("a1", { before: 10, limit: 3 });
  expect(before?.events.map((e) => e.seq)).toEqual([7, 8, 9]);
  const around = await store.page("a1", { around: 6, limit: 5 });
  expect(around?.events.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
  expect(around?.hasMore).toEqual({ before: true, after: true });
  expect(await store.page("a1", { around: 999, limit: 5 })).toBeNull();
});

test("turns and messages", async () => {
  const turnId = await store.openTurn("a1", null);
  await store.closeTurn(turnId, {
    isError: false,
    terminalReason: "completed",
    usage: {
      type: "usage",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
      durationMs: 9,
      numTurns: 1,
    },
  });
  const [turn] = await t.sql`select * from turns where id = ${turnId}`;
  expect(turn).toMatchObject({
    is_error: false,
    terminal_reason: "completed",
    model: "m",
    output_tokens: 2,
    cost_usd: "0.500000",
  });
  expect(turn?.ended_at).toBeTruthy();

  const m = await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a1",
    body: "hi",
    urgent: true,
  });
  expect((await store.pendingMessages("a1")).map((r) => r.id)).toEqual([m.id]);
  await store.markDelivered([m.id]);
  await store.setDeliveredTurn([m.id], turnId);
  expect(await store.pendingMessages("a1")).toEqual([]);
  await store.markPending([m.id]);
  const [row] = await store.pendingMessages("a1");
  expect(row).toMatchObject({
    id: m.id,
    state: "pending",
    deliveredAt: null,
    deliveredTurnId: null,
  });
});

test("pendingQueue returns system notices first, including sender-less rows", async () => {
  await store.createMessage({
    from: { userId: "u1" },
    toAgentId: "a2",
    body: "older",
    urgent: false,
  });
  await store.createNotice({ toAgentId: "a2", notice: "crash", body: "n" });
  const q = await store.pendingQueue("a2");
  expect(q.map((m) => m.body)).toEqual(["n", "older"]);
  expect(q.map((m) => m.fromHandle)).toEqual([null, "or"]);
});

test("createNotice replaces a pending notice of the same type and leaves a delivered one", async () => {
  await store.createNotice({ toAgentId: "a1", notice: "restart", body: "one" });
  const second = await store.createNotice({ toAgentId: "a1", notice: "restart", body: "two" });
  const pend = (await store.pendingQueue("a1")).filter((m) => m.kind === "system");
  expect(pend.map((m) => [m.id, m.body])).toEqual([[second.id, "two"]]);
  await store.markDelivered([second.id]);
  const third = await store.createNotice({ toAgentId: "a1", notice: "restart", body: "three" });
  expect(third.id).not.toBe(second.id);
  const [delivered] = await t.sql`select body from messages where id = ${second.id}`;
  expect(delivered?.body).toBe("two");
  await store.createNotice({ toAgentId: "a1", notice: "crash", body: "c" });
  await store.deletePendingNotices("a1");
  expect((await store.pendingQueue("a1")).filter((m) => m.kind === "system")).toEqual([]);
  const [still] = await t.sql`select state from messages where id = ${second.id}`;
  expect(still?.state).toBe("delivered");
});

test("credential pauses extend, never shorten; a conditional clear keeps a later window", async () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 14, min));
  expect(await store.pauseCredential("cred-a1", at(30), true)).toEqual({
    name: "cred-a1",
    until: at(30),
    exact: true,
  });
  expect(await store.pauseCredential("cred-a1", at(10), false)).toEqual({
    name: "cred-a1",
    until: at(30),
    exact: true,
  });
  expect(await store.pauseCredential("cred-a1", at(50), false)).toMatchObject({
    until: at(50),
    exact: false,
  });
  await store.clearCredentialPause("cred-a1", at(30)); // the timer of the old window
  expect(await store.pausedCredentials()).toEqual([
    { id: "cred-a1", name: "cred-a1", until: at(50), exact: false },
  ]);
  await store.clearCredentialPause("cred-a1", at(50));
  expect(await store.pausedCredentials()).toEqual([]);
  const [row] = await t.sql`select rate_limit_exact from credentials where id = 'cred-a1'`;
  expect(row?.rate_limit_exact).toBe(true);
});

test("owed agents: per credential, flag set and cleared", async () => {
  await store.setNoticeOwed("a1", true);
  expect(await store.owedAgents("cred-a1")).toEqual([{ id: "a1", slug: "dev" }]);
  expect(await store.owedAgents("cred-a2")).toEqual([]);
  await store.setNoticeOwed("a1", false);
  expect(await store.owedAgents("cred-a1")).toEqual([]);
});
