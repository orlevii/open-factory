import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createTestDb } from "../test/helpers.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { AgentStartError, NoOpenTurnError } from "./errors.ts";
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
let lastEnv: Record<string, string>;

async function makeRuntime(
  opts: { token?: string | null; sessionId?: string; status?: string } = {},
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
  lastEnv = env;
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
    holdTimeoutMs: 200,
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
});

test("starts on demand, writes one envelope turn, and persists everything in seq order", async () => {
  expect(rt.summary().status).toBe("hibernated");
  await send("hello");
  const p = driver.last;
  expect(p.opts).toEqual({});
  expect(p.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  expect(p.sent).toEqual([
    [{ id: expect.any(String), from: "@or", kind: "message", urgent: false, body: "hello" }],
  ]);
  expect(rt.summary().status).toBe("working");
  p.emit(ev.session(), ev.turn(), ev.text("hi"), ev.usage(), ev.end());
  await rt.settled();
  expect(await types()).toEqual([
    "process_started",
    "message_in",
    "session_started",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  expect(rt.summary()).toMatchObject({ status: "idle", turnOpen: false });
  const [agent] = await t.sql`select session_id from agents where id = ${agentId}`;
  expect(agent?.session_id).toBe("sess-1");
  const [m] = await msgRows();
  const turnEv = (await events()).find((e) => e.type === "turn_started");
  expect(m).toMatchObject({ state: "delivered", delivered_turn_id: turnEv?.turnId });
  const [turn] =
    await t.sql`select is_error, terminal_reason, ended_at, cost_usd from turns where id = ${turnEv?.turnId ?? null}`;
  expect(turn).toMatchObject({
    is_error: false,
    terminal_reason: "completed",
    cost_usd: "0.010000",
  });
  expect(frames.filter((f) => f.type === "session_event")).toHaveLength(7);
});

test("first batch is tentative: an exit before session_started rolls it back", async () => {
  await send("hello");
  const [before] = await msgRows();
  expect(before?.state).toBe("pending"); // written but not confirmed
  expect(rt.queueItems()).toEqual([]); // in flight: not in the queue
  driver.last.emit({
    type: "error",
    source: "resume",
    message: "No conversation found with session ID: x",
  });
  await rt.settled();
  driver.last.exit(1, "No conversation found");
  await rt.settled();
  // rollback is part of handling the exit, so delivery_failed comes right before exited
  expect(await types()).toEqual([
    "process_started",
    "message_in",
    "error",
    "delivery_failed",
    "exited",
  ]);
  const [after] = await msgRows();
  expect(after?.state).toBe("pending");
  expect(rt.queueItems().map((q) => q.body)).toEqual(["hello"]);
  expect(rt.summary()).toMatchObject({
    status: "errored",
    lastError: "No conversation found with session ID: x",
  });
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("errored");
});

test("resumes with the stored session id; a successful start clears errored", async () => {
  await makeRuntime({ sessionId: "sess-9", status: "errored" });
  expect(rt.summary().status).toBe("errored");
  await send("again");
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-9" });
  driver.last.emit(ev.session("sess-9"), ev.turn());
  await rt.settled();
  expect(rt.summary().status).toBe("working");
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("hibernated");
  expect((await events()).find((e) => e.type === "process_started")?.event).toEqual({
    type: "process_started",
    resumed: true,
  });
});

test("missing token fails before spawn: errored, 503-able error, message stays pending", async () => {
  await makeRuntime({ token: null });
  await expect(send("hello")).rejects.toBeInstanceOf(AgentStartError);
  expect(driver.starts).toHaveLength(0);
  expect(rt.summary()).toMatchObject({
    status: "errored",
    lastError: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents",
  });
  expect(rt.queueItems().map((q) => q.body)).toEqual(["hello"]);
  expect(await types()).toEqual(["error"]);
});

test("orphan-report turn after resume never takes the message", async () => {
  await makeRuntime({ sessionId: "sess-2" });
  await send("what word?");
  const p = driver.last;
  p.emit(
    { type: "background_task_finished", taskId: "b1", status: "stopped", summary: "Orphaned…" },
    ev.session("sess-2"),
    ev.turn(),
    ev.usage(),
    ev.end({ originKind: "task-notification", numTurns: 0, terminalReason: undefined }),
    ev.turn(),
    ev.text("HERON"),
    ev.usage(),
    ev.end(),
  );
  await rt.settled();
  const evs = await events();
  const turnIds = evs.filter((e) => e.type === "turn_started").map((e) => e.turnId);
  const [m] = await msgRows();
  expect(m?.delivered_turn_id).toBe(turnIds[1]);
  expect(evs.find((e) => e.type === "background_task_finished")?.turnId).toBeNull();
});

test("a message written mid-turn is attributed to the open turn", async () => {
  await send("first");
  const p = driver.last;
  p.emit(ev.session(), ev.turn(), { type: "tool_call", toolUseId: "t1", name: "Bash", input: {} });
  await rt.settled();
  await send("second");
  expect(p.sent).toHaveLength(2);
  p.emit(ev.text("both"), ev.usage(), ev.end());
  await rt.settled();
  const rows = await msgRows();
  expect(new Set(rows.map((r) => r.delivered_turn_id)).size).toBe(1);
});

test("background events after the last result don't open a turn; exited closes an open turn", async () => {
  await send("x");
  const p = driver.last;
  p.emit(
    ev.session(),
    ev.turn(),
    ev.usage(),
    ev.end(),
    { type: "background_tasks", tasks: [] },
    ev.turn(),
  );
  await rt.settled();
  expect((await events()).find((e) => e.type === "background_tasks")?.turnId).toBeNull();
  await rt.stop();
  const [open] =
    await t.sql`select count(*)::int as n from turns where agent_id = ${agentId} and ended_at is null`;
  expect(open?.n).toBe(0);
  const [stopped] = await t.sql`select count(*)::int as n from turns
    where agent_id = ${agentId} and terminal_reason = 'process_stopped' and is_error = false`;
  expect(stopped?.n).toBe(1);
  expect(rt.summary().status).toBe("hibernated");
});

test("unexpected exit: errored, open turn closed as process_exited; next send restarts with --resume", async () => {
  await send("x");
  driver.last.emit(ev.session("sess-5"), ev.turn());
  await rt.settled();
  driver.last.exit(1, "boom");
  await rt.settled();
  expect(rt.summary().status).toBe("errored");
  const [last] =
    await t.sql`select is_error, terminal_reason from turns where agent_id = ${agentId}`;
  expect(last).toEqual({ is_error: true, terminal_reason: "process_exited" });
  await send("y");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-5" });
});

test("interrupt: 409 while hibernated or starting; allowed with an open turn", async () => {
  await expect(rt.interrupt({ byHandle: "or" })).rejects.toBeInstanceOf(NoOpenTurnError);
  await send("x");
  await expect(rt.interrupt({ byHandle: "or" })).rejects.toBeInstanceOf(NoOpenTurnError); // starting, no turn
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  expect(rt.summary().turnOpen).toBe(true);
  await rt.interrupt({ byHandle: "or" });
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  expect((await events()).at(-1)?.event).toEqual({ type: "control", cmd: "interrupt", by: "@or" });
});

test("message_in always precedes its reply even when the reply is emitted during the write", async () => {
  await send("x");
  const p = driver.last;
  // emitted before the runtime's next job runs: still sequenced after message_in
  p.emit(ev.session(), ev.turn(), ev.text("r"), ev.usage(), ev.end());
  await rt.settled();
  const t2 = await types();
  expect(t2.indexOf("message_in")).toBeLessThan(t2.indexOf("assistant_text"));
});

test("a failing DB write stops the process and marks errored", async () => {
  await send("x");
  const p = driver.last;
  vi.spyOn(store, "append").mockRejectedValueOnce(new Error("db down"));
  p.emit(ev.session());
  await rt.settled();
  expect(rt.summary().status).toBe("errored");
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("errored");
});

test("several unconfirmed batches roll back to the head in their original order", async () => {
  await send("a");
  await send("b"); // still before session_started: a second tentative batch
  await send("c");
  expect(driver.last.sent.map((b) => b.map((m) => m.body))).toEqual([["a"], ["b"], ["c"]]);
  driver.last.exit(1);
  await rt.settled();
  expect(rt.queueItems().map((q) => q.body)).toEqual(["a", "b", "c"]);
  const failed = (await events()).filter((e) => e.type === "delivery_failed");
  expect(failed).toHaveLength(3);
  expect((await msgRows()).map((r) => r.state)).toEqual(["pending", "pending", "pending"]);
});

test("pending after a failed start, then delivered as one turn on the next start", async () => {
  await makeRuntime({ token: null });
  await expect(send("hello")).rejects.toBeInstanceOf(AgentStartError);
  // the token is fixed and the server restarted: a fresh runtime for the same agent
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    agent,
    store,
    bus,
    driver,
    config: loadConfig({ ...lastEnv, CLAUDE_CODE_OAUTH_TOKEN: "tok" }),
    log: silentLog,
  });
  await rt.init();
  expect(rt.queueItems().map((q) => q.body)).toEqual(["hello"]);
  await send("again");
  expect(driver.starts).toHaveLength(1);
  expect(driver.last.sent).toHaveLength(1);
  expect(driver.last.sent[0]?.map((m) => m.body)).toEqual(["hello", "again"]);
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  const rows = await msgRows();
  expect(rows.map((r) => r.state)).toEqual(["delivered", "delivered"]);
  expect(new Set(rows.map((r) => r.delivered_turn_id)).size).toBe(1);
  expect(rows[0]?.delivered_turn_id).not.toBeNull();
  expect(rt.summary().status).toBe("idle");
});

test("status: working while a batch awaits its turn, through an origin-tagged turn, then idle", async () => {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  expect(rt.summary()).toMatchObject({ status: "idle", turnOpen: false });
  await send("x"); // written with no open turn: awaiting
  expect(rt.summary()).toMatchObject({ status: "working", turnOpen: false });
  driver.last.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  expect(rt.summary()).toMatchObject({ status: "working", turnOpen: false });
  driver.last.emit(ev.turn());
  await rt.settled();
  expect(rt.summary()).toMatchObject({ status: "working", turnOpen: true });
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(rt.summary()).toMatchObject({ status: "idle", turnOpen: false });
  const statuses = frames.filter((f) => f.type === "agent_status").map((f) => f.status);
  expect(statuses.at(-1)).toBe("idle");
});

test("a DB failure after a stdin write in a send job stops the process and marks errored", async () => {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  vi.spyOn(store, "transaction").mockRejectedValueOnce(new Error("db down"));
  await expect(send("x")).rejects.toThrow("db down");
  await rt.settled();
  expect(driver.last.sent.at(-1)?.[0]?.body).toBe("x"); // the write itself happened
  expect(rt.summary().status).toBe("errored");
  expect((await events()).at(-1)?.event).toMatchObject({ type: "exited" }); // the process was stopped
  expect(rt.queueItems().map((q) => q.body)).toEqual(["x"]); // not lost: re-sent on the next start
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("errored");
  await send("y");
  expect(driver.starts).toHaveLength(2);
});

test("a DB failure recording process_started stops the new process instead of orphaning it", async () => {
  const real = store.append.bind(store);
  vi.spyOn(store, "append").mockImplementation(async (...args) => {
    if (args[2].type === "process_started") throw new Error("db down");
    return real(...args);
  });
  await expect(send("x")).rejects.toThrow("db down");
  await rt.settled();
  expect(rt.summary().status).toBe("errored");
  expect((await types()).at(-1)).toBe("exited"); // the pump ran and recorded the stop
  vi.restoreAllMocks();
  await send("y");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["x", "y"]);
});

test("an exit while the DB is failing still resets the runtime so a later send restarts", async () => {
  await send("x");
  driver.last.emit(ev.session("sess-7"), ev.turn());
  await rt.settled();
  await send("y"); // mid-turn: attributed to the open turn
  vi.spyOn(store, "append").mockRejectedValue(new Error("db down"));
  vi.spyOn(store, "closeTurn").mockRejectedValue(new Error("db down"));
  driver.last.exit(1, "boom");
  await rt.settled();
  expect(rt.summary()).toMatchObject({ status: "errored", turnOpen: false });
  vi.restoreAllMocks();
  await send("z");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-7" });
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["z"]);
});
