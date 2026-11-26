import type { ServerMessage } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { principalSql } from "../test/principals.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { AgentArchivedError, AgentStartError, NoOpenTurnError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore } from "./event-store.ts";
import { ev, type FakeDriver } from "./testing/fake-driver.ts";
import {
  noForward,
  noopTokens,
  okSpec,
  RuntimeHarness,
  sendAs,
  silentLog,
} from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
let t: RuntimeHarness["t"];
let store: EventStore;
beforeAll(async () => {
  await h.setup();
  ({ t, store } = h);
});
afterAll(() => h.close());

let driver: FakeDriver;
let bus: EventBus;
let frames: ServerMessage[];
let rt: AgentRuntime;
let agentId: string;

async function makeRuntime(opts: Parameters<RuntimeHarness["makeRuntime"]>[0] = {}) {
  await h.makeRuntime(opts);
  ({ driver, bus, frames, rt, agentId } = h);
  return rt;
}
const send = (body: string, urgent = false) =>
  sendAs(store, rt, { fromUserId: "u1", fromHandle: "or", body, urgent });
const events = async () =>
  (await store.after(agentId, 0, 1000)).map((e) => ({
    seq: e.seq,
    turnId: e.turnId,
    type: e.event.type,
    event: e.event,
  }));
const types = async () => (await events()).map((e) => e.type);
const msgRows = () =>
  t.sql`select id, state, delivered_turn_id from messages where to_id = ${agentId} order by created_at`;

beforeEach(async () => {
  await makeRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("starts on demand, writes one envelope turn, and persists everything in seq order", async () => {
  expect(rt.live().status).toBe("hibernated");
  await send("hello");
  const p = driver.last;
  expect(p.opts).toEqual({});
  expect(p.spec.env).toEqual({ TOKEN_SEEN: "yes" });
  expect(p.sent).toEqual([
    [
      {
        id: expect.any(String),
        from: expect.stringMatching(/^<@[0-9a-z]{8}\|or>$/),
        fromKind: "human",
        kind: "message",
        to: [expect.stringMatching(/^<@[0-9a-z]{8}\|[a-z0-9-]+>$/)],
        urgent: false,
        body: "hello",
        parts: [{ id: expect.any(String), body: "hello", createdAt: expect.any(String) }],
      },
    ],
  ]);
  expect(rt.live().status).toBe("working");
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
  expect(rt.live()).toMatchObject({ status: "idle", turnOpen: false });
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
  expect(rt.live()).toMatchObject({
    status: "errored",
    lastError: "No conversation found with session ID: x",
  });
  const [a] = await t.sql`select status from agents where id = ${agentId}`;
  expect(a?.status).toBe("errored");
});

test("resumes with the stored session id; the attempt's batch turn clears errored", async () => {
  await makeRuntime({ sessionId: "sess-9", status: "errored" });
  expect(rt.live().status).toBe("errored");
  await send("again");
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-9" });
  driver.last.emit(ev.session("sess-9"), ev.turn());
  await rt.settled();
  expect(rt.live().status).toBe("working");
  const [during] = await t.sql`select status, attempting from agents where id = ${agentId}`;
  expect(during).toEqual({ status: "errored", attempting: true });
  driver.last.emit(ev.end());
  await rt.settled();
  const [a] = await t.sql`select status, attempting from agents where id = ${agentId}`;
  expect(a).toEqual({ status: "hibernated", attempting: false });
  expect((await events()).find((e) => e.type === "process_started")?.event).toEqual({
    type: "process_started",
    resumed: true,
    reason: "message",
  });
});

test("a prepareStart failure is an error event with its fix, errored, 503-style AgentStartError, message pending", async () => {
  await makeRuntime({
    startError: new AgentStartError(
      "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.",
      "secrets",
    ),
  });
  await expect(send("hi")).rejects.toBeInstanceOf(AgentStartError);
  expect(driver.starts).toHaveLength(0);
  const evs = await store.after(agentId, 0, 100);
  expect(evs.at(-1)?.event).toEqual({
    type: "error",
    source: "spawn",
    message: "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.",
    fix: "secrets",
  });
  expect(rt.live().status).toBe("errored");
  expect(rt.queueItems()).toHaveLength(1);
});

test.each([
  [
    "edit_agent",
    "The credential no longer exists. Edit the agent and choose a credential.",
    "The credential no longer exists.",
  ],
] as const)(
  "a spawned agent's %s start error drops the fix and its advice for the terminate advice",
  async (fix, message, diagnosis) => {
    await makeRuntime({
      startError: new AgentStartError(message, fix, diagnosis),
      seed: async (id) => {
        await t.sql`insert into credentials (id, name, kind, value_enc) values (${`cred-lead-${id}`}, ${`lead-${id}`}, 'oauth_token', ${Buffer.from("x")})`;
        await t.sql.unsafe(principalSql(`lead-${id}`, "agent", `lead-${id}`));
        await t.sql`insert into agents (id, display_name, template, config, runtime, credential_id, reports_to)
                  select ${`lead-${id}`}, 'Lead', template, config, runtime, ${`cred-lead-${id}`}, reports_to from agents where id = ${id}`;
        await t.sql`update agents set kind = 'ephemeral', reports_to = ${`lead-${id}`} where id = ${id}`;
      },
    });
    await rt.reload();
    const expected = `${diagnosis} Terminate it and spawn a new one.`;
    await expect(send("hi")).rejects.toMatchObject({
      name: "AgentStartError",
      message: expected,
      fix: undefined,
    });
    expect((await store.after(agentId, 0, 100)).at(-1)?.event).toEqual({
      type: "error",
      source: "spawn",
      message: expected,
    });
    expect(rt.live()).toMatchObject({ status: "errored" });
  },
);

test("a spawned agent keeps other fixes (secrets) unchanged", async () => {
  const message = "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.";
  await makeRuntime({
    startError: new AgentStartError(message, "secrets"),
    seed: async (id) => {
      await t.sql`insert into credentials (id, name, kind, value_enc) values (${`cred-lead-${id}`}, ${`lead-${id}`}, 'oauth_token', ${Buffer.from("x")})`;
      await t.sql.unsafe(principalSql(`lead-${id}`, "agent", `lead-${id}`));
      await t.sql`insert into agents (id, display_name, template, config, runtime, credential_id, reports_to)
                  select ${`lead-${id}`}, 'Lead', template, config, runtime, ${`cred-lead-${id}`}, reports_to from agents where id = ${id}`;
      await t.sql`update agents set kind = 'ephemeral', reports_to = ${`lead-${id}`} where id = ${id}`;
    },
  });
  await rt.reload();
  await expect(send("hi")).rejects.toMatchObject({ message, fix: "secrets" });
});

test("an unexpected prepareStart failure is a generic AgentStartError, logged, never leaking its text", async () => {
  await makeRuntime({ startError: new Error("EACCES /secret/path") });
  await expect(send("hi")).rejects.toMatchObject({
    name: "AgentStartError",
    message: "The agent couldn't be prepared to start.",
  });
  expect((await store.after(agentId, 0, 100)).at(-1)?.event).toEqual({
    type: "error",
    source: "spawn",
    message: "The agent couldn't be prepared to start.",
  });
});

test("archived: send, compact and interrupt refuse inside the job; a message handed over is marked rejected", async () => {
  await makeRuntime();
  rt.markArchived();
  await expect(send("hi")).rejects.toBeInstanceOf(AgentArchivedError);
  await expect(rt.compact({ by: "<@or>" })).rejects.toBeInstanceOf(AgentArchivedError);
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toBeInstanceOf(AgentArchivedError);
  // The Router committed the row before the hand-off (S6 §7.3): its state tells the truth.
  expect(await t.sql`select state from messages where to_id = ${agentId}`).toEqual([
    { state: "rejected" },
  ]);
  expect(rt.queueItems()).toEqual([]);
});

test("prepareStart reporting an archived agent marks the runtime archived", async () => {
  await makeRuntime({ startError: new AgentArchivedError("dev") });
  await expect(send("hi")).rejects.toBeInstanceOf(AgentArchivedError);
  expect(rt.live().status).not.toBe("errored");
  await expect(rt.compact({ by: "<@or>" })).rejects.toBeInstanceOf(AgentArchivedError);
});

test("reload re-reads the row: a rename shows in summaries and archiving refuses sends", async () => {
  await makeRuntime();
  await t.sql`update agents set display_name = 'Renamed', archived_at = now() where id = ${agentId}`;
  await rt.reload();
  expect(rt.agent.displayName).toBe("Renamed");
  await expect(send("hi")).rejects.toBeInstanceOf(AgentArchivedError);
});

test("the runtime does not hold the handle lock around prepareStart (the real one takes it; KeyedMutex isn't re-entrant)", async () => {
  await makeRuntime();
  const lock = new KeyedMutex();
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: noForward,
    agent,
    store,
    bus,
    driver,
    log: silentLog,
    slots: new RecordingSlots(),
    prepareStart: (a) => lock.run(a.handle, async () => okSpec(a)),
  });
  await rt.init();
  const outcome = await Promise.race([
    send("hi").then(() => "sent"),
    new Promise((r) => setTimeout(() => r("deadlock"), 2000)),
  ]);
  expect(outcome).toBe("sent");
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
  expect(rt.live().status).toBe("hibernated");
});

test("unexpected exit mid-turn: open turn closed as process_exited; the recovery attempt resumes the session", async () => {
  await send("x");
  driver.last.emit(ev.session("sess-5"), ev.turn());
  await rt.settled();
  driver.last.exit(1, "boom");
  await rt.settled();
  expect(rt.live()).toMatchObject({
    errorKind: "crash",
    lastError: "Exited unexpectedly (code 1)",
  });
  const [last] =
    await t.sql`select is_error, terminal_reason from turns where agent_id = ${agentId}`;
  expect(last).toEqual({ is_error: true, terminal_reason: "process_exited" });
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-5" });
});

test("interrupt: 409 while hibernated or starting; allowed with an open turn", async () => {
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toBeInstanceOf(NoOpenTurnError);
  await send("x");
  await expect(rt.interrupt({ by: "<@or>" })).rejects.toBeInstanceOf(NoOpenTurnError); // starting, no turn
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  expect(rt.live().turnOpen).toBe(true);
  await rt.interrupt({ by: "<@or>" });
  expect(driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  expect((await events()).at(-1)?.event).toEqual({
    type: "control",
    cmd: "interrupt",
    by: "<@or>",
  });
});

test("the status frame carries the open turn's start time and a running compaction", async () => {
  const lastStatus = () => {
    const f = frames.filter((m) => m.type === "agent_status").at(-1);
    if (f?.type !== "agent_status") throw new Error("no agent_status frame");
    return f;
  };
  await send("x");
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  const started = (await store.after(agentId, 0, 1000)).find(
    (e) => e.event.type === "turn_started",
  );
  expect(started).toBeDefined();
  expect(lastStatus().turnStartedAt).toBe(started?.at);
  expect(rt.live().turnStartedAt).toBe(started?.at);
  expect(lastStatus().compacting).toBeFalsy();
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(lastStatus().turnOpen).toBe(false);
  expect(lastStatus()).not.toHaveProperty("turnStartedAt");

  await rt.compact({ by: "<@or>" });
  expect(driver.last.controls.at(-1)).toMatchObject({ cmd: "compact" });
  expect(lastStatus().compacting).toBe(true);
  driver.last.emit(ev.turn());
  await rt.settled();
  expect(lastStatus()).toMatchObject({ compacting: true, turnOpen: true });
  driver.last.emit(
    ev.usage(),
    ev.end({ command: "compact", terminalReason: undefined, numTurns: 0 }),
  );
  await rt.settled();
  expect(lastStatus().compacting).toBeFalsy();
  expect(lastStatus()).not.toHaveProperty("turnStartedAt");
});

test.each([
  ["a stop", () => rt.stop()],
  ["an unexpected exit", () => driver.last.exit(1)],
])("%s mid-turn clears the turn's start time", async (_name, end) => {
  await send("x");
  driver.last.emit(ev.session(), ev.turn());
  await rt.settled();
  expect(rt.live().turnStartedAt).toBeDefined();
  await end();
  await rt.settled();
  expect(rt.live()).not.toHaveProperty("turnStartedAt");
});

test("a failing DB write stops the process and marks errored", async () => {
  await send("x");
  const p = driver.last;
  vi.spyOn(store, "append").mockRejectedValueOnce(new Error("db down"));
  p.emit(ev.session());
  await rt.settled();
  expect(rt.live().status).toBe("errored");
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
  const failed = (await events()).filter((e) => e.type === "delivery_failed");
  expect(failed).toHaveLength(3);
  // The recovery attempt writes them again, in order, behind the crash notice.
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.sent[0]?.map((m) => [m.kind, m.body])).toEqual([
    ["system", expect.stringContaining("stopped unexpectedly")],
    ["message", "a"],
    ["message", "b"],
    ["message", "c"],
  ]);
});

test("pending after a failed start, then delivered as one turn on the next start", async () => {
  await makeRuntime({ startError: new AgentStartError("Secret X isn't set.", "secrets") });
  await expect(send("hello")).rejects.toBeInstanceOf(AgentStartError);
  // the secret is set and the server restarted: a fresh runtime for the same agent
  const agent = await store.agentById(agentId);
  if (!agent) throw new Error("no agent");
  rt = new AgentRuntime({
    tokens: noopTokens,
    forward: noForward,
    agent,
    store,
    bus,
    driver,
    prepareStart: async (a) => okSpec(a),
    log: silentLog,
    slots: new RecordingSlots(),
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
  expect(rt.live().status).toBe("idle");
});

test("status: working while a batch awaits its turn, through a zero-turn self-started result, then idle at the end of the self-started turn that read it", async () => {
  await send("boot");
  driver.last.emit(ev.session(), ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "idle", turnOpen: false });
  await send("x"); // written with no open turn: awaiting
  expect(rt.live()).toMatchObject({ status: "working", turnOpen: false });
  driver.last.emit(ev.turn(), ev.end({ originKind: "task-notification", numTurns: 0 }));
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "working", turnOpen: false });
  driver.last.emit(ev.turn());
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "working", turnOpen: true });
  driver.last.emit(ev.usage(), ev.end({ originKind: "task-notification" }));
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "idle", turnOpen: false });
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
  expect(rt.live().status).toBe("errored");
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
  expect(rt.live().status).toBe("errored");
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
  expect(rt.live()).toMatchObject({ status: "errored", turnOpen: false });
  vi.restoreAllMocks();
  await send("z");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts).toEqual({ resumeSessionId: "sess-7" });
  expect(driver.last.sent.at(-1)?.map((m) => m.body)).toEqual(["z"]);
});
