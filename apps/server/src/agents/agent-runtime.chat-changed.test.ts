import type { ServerMessage } from "@open-factory/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { principalSql } from "../test/principals.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness, sendAs } from "./testing/runtime-harness.ts";

// I1 §6.5: chat_changed{agent} goes to each human whose message the runtime wrote, started, closed, cancelled,
// restored or rejected, and to nobody else.

const h = new RuntimeHarness();
beforeAll(async () => {
  await h.setup();
  await h.t.sql.unsafe(principalSql("u2", "human", "ann"));
  await h.t.sql`insert into users (id, name, email) values ('u2', 'Ann', 'ann@x.io')`;
});
afterAll(() => h.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return () => vi.useRealTimers();
});

let u1: ServerMessage[];
let u2: ServerMessage[];
/** A fresh runtime with both users listening. */
async function start() {
  await h.makeRuntime();
  u1 = [];
  u2 = [];
  h.bus.subscribeUser("u1", (m) => u1.push(m));
  h.bus.subscribeUser("u2", (m) => u2.push(m));
}
const frame = () => ({ type: "chat_changed", agent: h.rt.agent.slug });
const count = (got: ServerMessage[]) => got.filter((m) => m.type === "chat_changed").length;
const sendU2 = (body: string) => sendAs(h.store, h.rt, { fromUserId: "u2", body, urgent: false });

test("writing a batch tells its human sender, and only them", async () => {
  await start();
  await h.send("hello");
  expect(u1).toContainEqual(frame());
  expect(u2).toEqual([]);
});

test("turn_started and the turn's close each tell the sender of the awaiting batch", async () => {
  await start();
  await h.send("hello");
  const afterWrite = count(u1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  expect(count(u1)).toBeGreaterThan(afterWrite);
  const afterStart = count(u1);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(count(u1)).toBeGreaterThan(afterStart);
  expect(u2).toEqual([]);
});

test("a message absorbed into an open turn tells its sender when the turn closes", async () => {
  await start();
  await h.send("boot");
  h.driver.last.emit(...ev.fullTurn());
  await h.rt.settled();
  h.driver.last.emit(ev.turn()); // a self-started turn: nothing awaits
  await h.rt.settled();
  await sendU2("mid-turn");
  const before = count(u2);
  h.driver.last.emit(ev.usage(), ev.end());
  await h.rt.settled();
  expect(count(u2)).toBeGreaterThan(before);
});

test("an exit with a written batch tells its sender", async () => {
  await start();
  await h.send("hello");
  const before = count(u1);
  h.driver.last.exit(1, "boom");
  await h.rt.settled();
  expect(count(u1)).toBeGreaterThan(before);
  expect(u2).toEqual([]);
});

test("cancel and restore tell the sender", async () => {
  await start();
  await h.send("work");
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await h.rt.interrupt({ byHandle: "or" });
  const b = await h.send("B");
  const before = count(u1);
  await h.rt.cancelQueued(b.id, "u1");
  expect(count(u1)).toBe(before + 1);
  await h.rt.restoreQueued(b.id, "u1");
  expect(count(u1)).toBe(before + 2);
  expect(u2).toEqual([]);
});

test("a message rejected by an archived agent tells its sender", async () => {
  await start();
  h.rt.markArchived();
  await expect(h.send("hi")).rejects.toBeDefined();
  expect(u1).toContainEqual(frame());
  expect(u2).toEqual([]);
});

test("queued rows dropped by a committed termination tell their senders", async () => {
  await start();
  await h.send("boot");
  h.driver.last.failWrites = true;
  await h.send("queued");
  u1.length = 0;
  h.rt.markTerminated({ committed: true });
  await h.rt.settled();
  expect(u1).toContainEqual(frame());
  expect(u2).toEqual([]);
});

test("session_started tells the sender of a batch written before it that the row is delivered", async () => {
  await start();
  await h.send("cold");
  const before = count(u1);
  h.driver.last.emit(ev.session());
  await h.rt.settled();
  expect(count(u1)).toBeGreaterThan(before);
  expect(u2).toEqual([]);
});
