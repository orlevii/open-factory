import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { EventStore } from "./event-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  await t.sql`insert into agents (id, slug, display_name) values ('a1', 'dev', 'Dev agent'), ('a2', 'b', 'B')`;
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
  const turnId = await store.openTurn("a1");
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
    fromUserId: "u1",
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
