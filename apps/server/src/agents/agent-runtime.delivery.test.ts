import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../test/helpers.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { NoOpenTurnError } from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import { EventStore } from "./event-store.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  await t.sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
});
afterAll(() => t.close());

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
let driver: FakeDriver;
let bus: EventBus;
let frames: ServerMessage[];
let rt: AgentRuntime;
let agentId: string;

async function makeRuntime(
  opts: { token?: string | null; sessionId?: string; status?: string; realHold?: boolean } = {},
) {
  n += 1;
  agentId = `a${n}`;
  await t.sql`insert into agents (id, slug, display_name, session_id, status)
              values (${agentId}, ${`dev${n}`}, 'Dev agent', ${opts.sessionId ?? null}, ${opts.status ?? "hibernated"})`;
  const env: Record<string, string> = {
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: mkdtempSync(path.join(tmpdir(), "of-")),
  };
  if (opts.token !== null) env.CLAUDE_CODE_OAUTH_TOKEN = opts.token ?? "tok";
  driver = new FakeDriver();
  bus = new EventBus();
  frames = [];
  bus.subscribeAll((m) => frames.push(m));
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  bus.subscribe(agent.slug, (m) => frames.push(m));
  rt = new AgentRuntime({
    agent,
    store,
    bus,
    driver,
    config: loadConfig(env),
    log: silentLog,
    ...(opts.realHold ? {} : { holdTimeoutMs: 200 }),
  });
  await rt.init();
  return rt;
}
const send = (body: string, urgent = false) =>
  rt.sendMessage({ fromUserId: "u1", fromHandle: "or", body, urgent });
const events = async () =>
  (await store.after(agentId, 0, 1000)).map((e) => ({
    seq: e.seq,
    turnId: e.turnId,
    type: e.event.type,
    event: e.event,
  }));
const types = async () => (await events()).map((e) => e.type);
const msgRows = () =>
  t.sql`select id, state, delivered_turn_id from messages where to_agent_id = ${agentId} order by created_at`;

beforeEach(async () => {
  await makeRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/** Only the hold timer is faked: Postgres I/O and setImmediate (used by settled()) stay real. */
const fakeHoldTimer = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

async function startedIdle() {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
}

test("a rejected write keeps the message pending at the head; the next flush sends it with the newer one as one batch", async () => {
  await startedIdle();
  driver.last.failWrites = true;
  const a = await send("a"); // write rejected: stays queued, delivery_failed appended once
  expect(rt.queueItems().map((q) => q.body)).toEqual(["a"]);
  const failed = (await events()).filter((e) => e.type === "delivery_failed");
  expect(failed.map((e) => e.event)).toEqual([
    { type: "delivery_failed", messageIds: [a.id], reason: "The agent process is not running" },
  ]);
  const rowA = (await msgRows()).find((r) => r.id === a.id);
  expect(rowA?.state).toBe("pending");
  driver.last.failWrites = false;
  await send("b");
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["a", "b"]);
  expect(rt.queueItems()).toEqual([]);
});

test("compact is a barrier: written only with no open turn, and nothing passes it until its turn ends", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  await rt.compact({ focus: "keep the API", byHandle: "or" });
  await send("after compact");
  expect(driver.last.controls).toEqual([]); // turn open: compact waits
  expect(rt.queueItems().map((q) => q.kind)).toEqual(["compact", "message"]);
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact", arg: "keep the API" }]);
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task"); // "after compact" not written yet
  expect(rt.summary().status).toBe("working"); // compact in flight
  // a self-started turn ending meanwhile does not release the barrier
  driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task");
  driver.last.emit(
    ev.turn(),
    { type: "compacted", trigger: "manual", preTokens: 100, postTokens: 10 },
    ev.usage(),
    ev.end({ command: "compact", terminalReason: undefined, numTurns: 0 }),
  );
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("after compact");
  expect((await events()).find((e) => e.type === "control")?.event).toEqual({
    type: "control",
    cmd: "compact",
    arg: "keep the API",
    by: "@or",
  });
});

test("urgent while a turn is open: interrupt first, hold, then the message on the turn's result", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn(), { type: "tool_call", toolUseId: "t1", name: "Bash", input: {} });
  await rt.settled();
  await send("STOP", true);
  await send("and this");
  const w = driver.last.writes;
  expect(w.at(-1)).toEqual({ kind: "control", cmd: "interrupt" }); // nothing written after the interrupt yet
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP", "and this"]);
  await send("third, urgent again", true);
  expect(driver.last.controls.filter((c) => c.cmd === "interrupt")).toHaveLength(1); // no second interrupt
  driver.last.emit(ev.usage(), ev.end({ isError: true, terminalReason: "aborted_tools" }));
  await rt.settled();
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual([
    "STOP",
    "and this",
    "third, urgent again",
  ]);
});

test("the hold is released after 10 s if no result arrives", async () => {
  await makeRuntime({ realHold: true });
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await send("STOP", true);
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task");
  await vi.advanceTimersByTimeAsync(9_999);
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("long task");
  await vi.advanceTimersByTimeAsync(1);
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("STOP");
});

test("a DB failure in the hold-timeout flush stops the process and marks errored", async () => {
  await makeRuntime({ realHold: true });
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await send("STOP", true);
  vi.spyOn(store, "transaction").mockRejectedValueOnce(new Error("db down"));
  await vi.advanceTimersByTimeAsync(10_000);
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("STOP");
  expect(rt.summary().status).toBe("errored");
  expect((await types()).at(-1)).toBe("exited");
});

test("urgent while a compact is in flight does not interrupt it; it waits behind the barrier", async () => {
  await startedIdle();
  await rt.compact({ byHandle: "or" });
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact" }]);
  driver.last.emit(ev.turn()); // the compact turn opens
  await rt.settled();
  await send("STOP", true);
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "compact" }]); // no interrupt
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP"]);
  driver.last.emit(
    ev.usage(),
    ev.end({ command: "compact", terminalReason: undefined, numTurns: 0 }),
  );
  await rt.settled();
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["STOP"]);
});

test("urgent while idle is a normal send", async () => {
  await startedIdle();
  await send("now", true);
  expect(driver.last.controls).toEqual([]);
  expect(driver.last.sent.at(-1)?.[0]).toMatchObject({ body: "now", urgent: true });
});

test("after an unexpected exit nothing restarts the process until the next API call", async () => {
  await makeRuntime({ realHold: true });
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  fakeHoldTimer();
  await send("STOP", true);
  driver.last.exit(1);
  await rt.settled();
  // the exit clears the hold; even past its 10 s nothing flushes or restarts the dead process
  await vi.advanceTimersByTimeAsync(10_000);
  await rt.settled();
  expect(driver.starts).toHaveLength(1);
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP"]);
});

test("a rejected interrupt write (process going away) is not an internal error: urgent stays queued, Interrupt is 409", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  driver.last.failWrites = true; // the process is exiting; its `exited` has not been processed yet
  const item = await send("STOP", true); // resolves: no 500
  expect(item.body).toBe("STOP");
  await expect(rt.interrupt({ byHandle: "or" })).rejects.toBeInstanceOf(NoOpenTurnError);
  expect(driver.last.controls).toEqual([]);
  expect(rt.summary().status).not.toBe("errored");
  expect(rt.queueItems().map((q) => q.body)).toEqual(["STOP"]);
  await rt.stop(); // the expected exit arrives
  expect(rt.summary().status).toBe("hibernated");
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("hibernated");
  await send("next");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["STOP", "next"]);
});

test("a rejected interrupt write before an unexpected exit keeps the real exit reason", async () => {
  await startedIdle();
  await send("long task");
  driver.last.emit(ev.turn());
  await rt.settled();
  driver.last.failWrites = true;
  await send("STOP", true);
  driver.last.exit(1);
  await rt.settled();
  expect(rt.summary()).toMatchObject({
    status: "errored",
    lastError: "Exited unexpectedly (code 1)",
  });
});
