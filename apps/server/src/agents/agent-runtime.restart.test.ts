import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { MountCheckContext } from "../workspace/mounts.ts";
import type { AgentRuntime, DockerDeps } from "./agent-runtime.ts";
import { AgentStartError } from "./errors.ts";
import type { EventStore } from "./event-store.ts";
import { notices, parseConfigNotice } from "./notices.ts";
import { ev, type FakeDriver, type FakeProcess } from "./testing/fake-driver.ts";
import { deliverHuman, okSpec, RuntimeHarness, testEffective } from "./testing/runtime-harness.ts";
import { RecordingSlots } from "./testing/slots.ts";

const h = new RuntimeHarness();
let store: EventStore;
beforeAll(async () => {
  await h.setup();
  store = h.store;
});
afterAll(() => h.close());

let driver: FakeDriver;
let rt: AgentRuntime;
let agentId: string;
async function makeRuntime() {
  await h.makeRuntime();
  ({ driver, rt, agentId } = h);
}
beforeEach(makeRuntime);

const send = (body: string, urgent = false) => h.send(body, urgent);
const bg = ev.background;
const types = async () => (await store.after(agentId, 0, 1000)).map((e) => e.event.type);
const startReasons = async () =>
  (await store.after(agentId, 0, 1000)).flatMap((e) =>
    e.event.type === "process_started" ? [e.event.reason] : [],
  );
/** A started, idle process on session sess-1. */
async function idle() {
  await send("hi");
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
}

test("not running: no-op", async () => {
  await rt.requestRestart();
  expect(rt.live().restartPending).toBe(false);
  expect(driver.starts).toHaveLength(0);
});

test("idle: stops now; next message resumes the same session", async () => {
  await idle();
  await rt.requestRestart();
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(rt.live()).toMatchObject({ status: "hibernated", restartPending: false });
  expect(await types()).not.toContain("delivery_failed");
  await send("again");
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts.resumeSessionId).toBe("sess-1");
});

test.each([
  [
    "an open turn",
    (p: FakeProcess) => p.emit(ev.session(), ev.turn()),
    (p: FakeProcess) => p.emit(ev.usage(), ev.end()),
  ],
  [
    "a live background task",
    (p: FakeProcess) => p.emit(bg([{ taskId: "t1" }])),
    (p: FakeProcess) => p.emit(bg([])),
  ],
  [
    // background-bash-start-finish: the empty task set arrives before the notification turn starts
    "an owed notification turn",
    (p: FakeProcess) => p.emit(ev.taskFinished("t1"), bg([])),
    (p: FakeProcess) => p.emit(ev.turn(), ev.usage(), ev.end({ originKind: "task-notification" })),
  ],
  [
    "a compact in flight",
    async (p: FakeProcess) => {
      await rt.compact({ by: "<@or>" });
      expect(p.controls).toEqual([{ kind: "control", cmd: "compact" }]);
    },
    (p: FakeProcess) => p.emit(ev.turn(), ev.end({ command: "compact" })),
  ],
] as const)("waits for %s", async (_n, busy, release) => {
  await idle();
  await busy(driver.last);
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(driver.last.stopped).toBe(false);
  expect(rt.live().restartPending).toBe(true);
  release(driver.last);
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(rt.live().restartPending).toBe(false);
});

test("waits for a batch awaiting its turn", async () => {
  await idle();
  await send("next"); // written with no open turn: awaiting
  await rt.requestRestart();
  await rt.settled();
  expect(driver.last.stopped).toBe(false);
  driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("waits for a batch in flight (no session_started yet)", async () => {
  await send("hi");
  await rt.requestRestart();
  await rt.settled();
  expect(rt.live().restartPending).toBe(true);
  expect(driver.last.stopped).toBe(false);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("waits for an urgent interrupt and the message it releases", async () => {
  await idle();
  driver.last.emit(ev.turn());
  await rt.settled();
  await send("now", true); // interrupt + hold
  await rt.requestRestart();
  driver.last.emit(ev.usage(), ev.end({ terminalReason: "aborted_streaming" }));
  await rt.settled();
  // turn_end released the hold and wrote the urgent message with no open turn: it awaits its turn
  expect(driver.last.stopped).toBe(false);
  driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("an urgent hold that times out mid-turn doesn't restart; the turn's end does", async () => {
  await idle();
  driver.last.emit(ev.turn());
  await rt.settled();
  await send("now", true); // interrupt + hold; the turn never acknowledges it
  await rt.requestRestart();
  await new Promise((r) => setTimeout(r, 300)); // past the harness's 200 ms hold timeout
  await rt.settled();
  // the hold-timeout job released the hold and wrote the message into the still-open turn
  expect(driver.last.sent.flat().map((m) => m.body)).toEqual(["hi", "now"]);
  expect(driver.last.stopped).toBe(false);
  expect(rt.live().restartPending).toBe(true);
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("ambient tasks don't block; restartWaitingOn counts non-ambient ones", async () => {
  await send("hi");
  driver.last.emit(...ev.fullTurn("sess-1"), bg([{ taskId: "a", ambient: true }, { taskId: "b" }]));
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(rt.live()).toMatchObject({ restartPending: true, restartWaitingOn: 1 });
  expect(rt.statusFrame()).toMatchObject({ restartPending: true, restartWaitingOn: 1 });
  driver.last.emit(bg([{ taskId: "a", ambient: true }]));
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
});

test("a message during the stop grace is held, then delivered after the restart without delivery_failed", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const p = send("during");
  await rt.settled();
  expect(driver.starts[0]?.sent).toHaveLength(1);
  driver.starts[0]?.releaseStop();
  await p;
  await rt.settled();
  expect(driver.starts).toHaveLength(2);
  expect(driver.last.opts.resumeSessionId).toBe("sess-1");
  expect(driver.last.sent.flat().map((m) => m.body)).toEqual(["during"]);
  expect(await types()).not.toContain("delivery_failed");
  expect(rt.queueItems()).toEqual([]);
});

test("pending items trigger the restart's own start; a start failure keeps its real error", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const p = deliverHuman(rt, await h.row("queued")).catch(() => {}); // pending before the exit, not after it
  h.startError = new AgentStartError(
    "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.",
    "secrets",
  );
  driver.starts[0]?.releaseStop();
  await p;
  await rt.settled();
  expect(driver.starts).toHaveLength(1);
  expect(rt.live().status).toBe("errored");
  expect(rt.live().lastError).toBe("Secret GH_TOKEN isn't set. Add it in Settings → Secrets.");
  expect(rt.queueItems().map((i) => i.kind)).toEqual(["message"]);
});

test("shutdown during the grace never respawns", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  // The row first, then its delivery enqueued ahead of the stop: a message whose insert lands after the stop is done
  // isn't one that arrived during the grace, and rightly wakes the agent (no closing latch here).
  const s = deliverHuman(rt, await h.row("x")).catch(() => {});
  const stopping = rt.stop();
  expect(rt.live().restartPending).toBe(false);
  driver.starts[0]?.releaseStop();
  await stopping;
  await s;
  await rt.settled();
  expect(driver.starts).toHaveLength(1);
});

test("archive during the grace never respawns and clears restartPending", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const s = deliverHuman(rt, await h.row("x")).catch(() => {}); // delivered during the grace, not after it
  await rt.settled();
  rt.markArchived();
  const stopping = rt.stop({ graceMs: 3000, termWaitMs: 10_000 });
  driver.starts[0]?.releaseStop();
  await stopping;
  await s;
  await rt.settled();
  expect(driver.starts).toHaveLength(1);
  expect(rt.live().restartPending).toBe(false);
});

test("a timed-out stop escalates and its exit runs the restart's intent", async () => {
  await idle();
  driver.last.stopResult = { code: null, signal: null, timedOut: true };
  driver.last.emitExitOnStop = false;
  await rt.requestRestart();
  await rt.settled();
  expect(driver.last.forceKilled).toBe(true);
  expect(rt.live().status).toBe("hibernated");
  expect(rt.live().restartPending).toBe(false);
  const evs = (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
  expect(evs).toContainEqual({ type: "stop_escalated", how: "sigkill" });
  expect(evs.at(-1)).toMatchObject({ type: "hibernated", reason: "apply_changes" });
});

test("a stop() that takes over a timing-out restart doesn't mark it errored", async () => {
  await idle();
  driver.last.holdStop = true;
  driver.last.stopResult = { code: null, signal: null, timedOut: true };
  driver.last.emitExitOnStop = false;
  await rt.requestRestart();
  const stopping = rt.stop();
  driver.starts[0]?.releaseStop();
  await stopping;
  await rt.settled();
  expect(rt.live().status).not.toBe("errored");
});

test("a shutdown landing while the restart's exit job is in prepareStart never spawns, and stop() resolves", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const s = deliverHuman(rt, await h.row("x")).catch(() => {});
  await rt.settled();
  let open: () => void = () => {};
  h.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  driver.starts[0]?.releaseStop();
  await h.prepared(2); // the exit job is suspended in the respawn's prepare
  const stopping = rt.stop({ graceMs: 3000, termWaitMs: 10_000 });
  open();
  await stopping; // a stop() that never resolved fails at the test timeout
  await s;
  expect(driver.starts).toHaveLength(1);
  expect(rt.live().status).toBe("hibernated");
  expect(rt.queueItems().map((i) => (i.kind === "message" ? i.body : i.kind))).toEqual(["x"]); // still pending for the next start
});

test("a shutdown landing while the restart's exit is being recorded never spawns", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const s = deliverHuman(rt, await h.row("x")).catch(() => {});
  await rt.settled();
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let reach: () => void = () => {};
  const reached = new Promise<void>((r) => {
    reach = r;
  });
  const real = store.append.bind(store);
  const spy = vi.spyOn(store, "append").mockImplementation(async (...args) => {
    if (args[2].type === "exited") {
      reach();
      await gate;
    }
    return real(...args);
  });
  try {
    driver.starts[0]?.releaseStop();
    await reached;
    const stopping = rt.stop();
    open();
    await stopping;
    await s;
    expect(driver.starts).toHaveLength(1);
    expect(h.prepareCalls).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("a send after a completed stop starts normally (stopping doesn't stick)", async () => {
  await idle();
  await rt.stop();
  await send("again");
  expect(driver.starts).toHaveLength(2);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("requestRestart on a process that failed to start (errored, stopping) sets nothing", async () => {
  await send("hi");
  driver.last.holdStop = true;
  driver.last.emit({ type: "error", source: "resume", message: "No conversation found" });
  await rt.settled();
  await rt.requestRestart();
  expect(rt.live()).toMatchObject({ status: "errored", restartPending: false });
  driver.last.releaseStop();
  await rt.settled();
});

test("requestRestart on a fresh process after an idle crash still applies", async () => {
  await idle();
  driver.last.exit(1);
  await rt.settled();
  expect(rt.live().status).toBe("hibernated"); // nothing was lost (spec §9.2)
  await send("again"); // starts with the old config
  await rt.requestRestart();
  expect(rt.live().restartPending).toBe(true);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
});

test("an unexpected exit clears restartPending; only the crash recovery starts again", async () => {
  await send("hi");
  driver.last.emit(...ev.fullTurn("sess-1"), ev.turn());
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(rt.live().restartPending).toBe(true);
  driver.last.exit(1);
  await rt.settled();
  expect(rt.live().restartPending).toBe(false);
  expect(driver.starts).toHaveLength(2);
  const started = (await h.store.after(h.agentId, 0, 1000)).filter(
    (e) => e.event.type === "process_started",
  );
  expect(started.at(-1)?.event).toMatchObject({ reason: "crash_recovery" });
});

test("requestRestart racing a start: the start wins the queue, the restart waits for the first turn", async () => {
  const row = await h.row("hi");
  const p = deliverHuman(rt, row); // enqueued first: the start wins the queue
  const r = rt.requestRestart();
  await Promise.all([p, r]);
  expect(driver.starts).toHaveLength(1);
  expect(rt.live().restartPending).toBe(true);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
});

test("requestRestart racing a start: the restart wins the queue and is a no-op", async () => {
  const r = rt.requestRestart();
  const p = send("hi");
  await Promise.all([p, r]);
  expect(rt.live().restartPending).toBe(false);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  expect(driver.last.stopped).toBe(false);
});

test("a fresh process after a restart doesn't inherit the old task set or notification debt", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const p = send("after");
  driver.last.emit(bg([{ taskId: "late" }]), ev.taskFinished("late"));
  await rt.settled();
  driver.starts[0]?.releaseStop();
  await p;
  await rt.settled();
  expect(driver.starts).toHaveLength(2);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(rt.live().restartWaitingOn).toBe(0);
  expect(driver.starts[1]?.stopped).toBe(true);
});

test("apply-restart doesn't wait for crons; the agent is told which stopped", async () => {
  await idle();
  driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  await rt.requestRestart();
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(await types()).toEqual(expect.arrayContaining(["background_work_lost", "hibernated"]));
  const lost = (await store.after(agentId, 0, 1000)).find(
    (e) => e.event.type === "background_work_lost",
  );
  expect(lost?.event).toEqual({
    type: "background_work_lost",
    reason: "apply_changes",
    tasks: [],
    crons: [{ cronId: "c1", humanSchedule: "every 5 minutes" }],
  });
  expect(driver.starts).toHaveLength(2); // woken at once
  expect(driver.last.sent[0]?.[0]).toMatchObject({
    kind: "system",
    body: expect.stringContaining("every 5 minutes"),
  });
  expect((await startReasons()).at(-1)).toBe("apply_changes");
});

test("apply-restart with nothing lost and nothing queued stays hibernated", async () => {
  await idle();
  await rt.requestRestart();
  await rt.settled();
  expect(await types()).not.toContain("background_work_lost");
  expect(driver.starts).toHaveLength(1);
  expect(rt.queueItems()).toEqual([]);
});

// ---------- I2 §6.2, §7.3: started config, the config_changed notice, restart with a change list ----------

/** The agent's `config_changed` rows. */
const configRows = async () =>
  h.t.sql<{ id: string; body: string; state: string }[]>`
    select id, body, state from messages
    where to_id = ${agentId} and kind = 'system' and notice = 'config_changed'
    order by created_at`;
/** Every body a process was sent, batch by batch. */
const batches = (p: FakeProcess | undefined) => (p?.sent ?? []).map((b) => b.map((m) => m.body));
const CONFIG = notices.configChanged(["model: sonnet → opus"]);

test("config_changed is passive: it never wakes a hibernated agent, at runtime or at boot", async () => {
  await rt.recordConfigNotice(["model: sonnet → opus"]);
  await rt.settled();
  expect(driver.starts).toHaveLength(0);
  expect(rt.hasDeliverable()).toBe(false);
  expect(rt.queueItems().map((i) => i.kind)).toEqual(["notice"]);
  expect((await store.bootWakes()).map((w) => w.id)).not.toContain(agentId);
  // A message wakes it; the notice rides at the head of that first batch.
  await send("hi");
  expect(batches(driver.last)).toEqual([[CONFIG, "hi"]]);
});

test("config_changed on an idle process is never written on its own", async () => {
  await idle();
  await rt.recordConfigNotice(["model: sonnet → opus"]);
  await rt.settled();
  expect(batches(driver.last)).toEqual([["hi"]]);
  expect(rt.hibernatable()).toBe(true); // passive: it keeps nothing up
});

test("two config notices before delivery are one pending row: the union of the lines, sorted", async () => {
  await rt.recordConfigNotice(["model: sonnet → opus", "added skill release"]);
  await rt.recordConfigNotice(["env LOG_LEVEL changed", "added skill release"]);
  const rows = await configRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("pending");
  expect(parseConfigNotice(rows[0]?.body ?? "")).toEqual([
    "added skill release",
    "env LOG_LEVEL changed",
    "model: sonnet → opus",
  ]);
  expect(rt.queueItems()).toHaveLength(1);
  expect(rt.queueItems()[0]?.body).toBe(rows[0]?.body);
});

test("concurrent merges through the store never create two rows", async () => {
  const m = (line: string) =>
    store.createNotice({
      toAgentId: agentId,
      notice: "config_changed",
      body: notices.configChanged([line]),
    });
  await Promise.all([m("b"), m("a"), m("c")]);
  const rows = await configRows();
  expect(rows).toHaveLength(1);
  expect(parseConfigNotice(rows[0]?.body ?? "")).toEqual(["a", "b", "c"]);
});

test("a change after the process started is held from it: a message between the change and the restart doesn't carry it, the first batch after the restart does", async () => {
  await idle();
  await rt.recordConfigNotice(["model: sonnet → opus"]);
  await send("between");
  expect(batches(driver.starts[0])).toEqual([["hi"], ["between"]]);
  driver.last.emit(ev.turn(), ev.usage(), ev.end());
  await rt.settled();
  await rt.requestRestart({ changes: ["model: sonnet → opus"] });
  await rt.settled();
  expect(driver.starts[0]?.stopped).toBe(true);
  expect(driver.starts).toHaveLength(1); // the passive notice alone wakes nothing
  expect((await configRows())[0]?.state).toBe("pending");
  await send("after");
  expect(driver.starts).toHaveLength(2);
  expect(batches(driver.starts[1])).toEqual([[CONFIG, "after"]]);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  expect((await configRows())[0]?.state).toBe("delivered");
});

test("a change landing while the start is in prepare is held for the next process", async () => {
  let open: () => void = () => {};
  h.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  const p = send("hi");
  await h.prepared(1); // the start read the config (or is about to): the change may be missing from it
  const row = await store.createNotice({
    toAgentId: agentId,
    notice: "config_changed",
    body: CONFIG,
  });
  const adopted = rt.adoptNotice(row.id); // queued behind the start job
  open();
  await p;
  await adopted;
  await rt.settled();
  expect(rt.queueItems().map((i) => i.kind)).toEqual(["notice"]);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  await send("next"); // stamped before the prepare: the row is newer than this process
  expect(batches(driver.last)).toEqual([["hi"], ["next"]]);
  expect((await configRows()).map((r) => r.state)).toEqual(["pending"]);
});

test("a change after the first batch is a new row, held for the next process", async () => {
  await rt.recordConfigNotice(["added skill release"]); // pending before any process
  await send("hi"); // delivered with this first batch
  expect(batches(driver.last)).toEqual([[notices.configChanged(["added skill release"]), "hi"]]);
  driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
  await rt.recordConfigNotice(["model: sonnet → opus"]); // a new row: the first one was delivered
  await send("next");
  expect(batches(driver.last).at(-1)).toEqual(["next"]);
  expect((await configRows()).map((r) => r.state)).toEqual(["delivered", "pending"]);
});

test.each([
  [
    "a crons takeover of the restart",
    async () => {
      driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
      await rt.settled();
      driver.last.holdStop = true;
      await rt.requestRestart({ changes: ["model: sonnet → opus"] });
      expect(await rt.stopCrons("or")).toEqual({ status: "stopped" });
      driver.last.releaseStop();
    },
  ],
  ["a shutdown", () => rt.stop()],
  ["a crash", async () => driver.last.exit(1)],
] as const)(
  "after %s the notice is still pending and the next start delivers it",
  async (_n, exit) => {
    await idle();
    await rt.recordConfigNotice(["model: sonnet → opus"]);
    await exit();
    await rt.settled();
    expect(rt.live().status).toBe("hibernated");
    expect(driver.starts).toHaveLength(1);
    expect((await configRows()).map((r) => r.state)).toEqual(["pending"]);
    await send("again");
    expect(driver.starts).toHaveLength(2);
    const [first] = batches(driver.last);
    expect(first?.[0]).toBe(CONFIG);
    expect(first?.at(-1)).toBe("again");
  },
);

test("lost crons on an apply_changes exit still add a non-passive restart_crons that wakes the agent, the config notice with it", async () => {
  await idle();
  driver.last.emit(ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  await rt.recordConfigNotice(["model: sonnet → opus"]);
  await rt.requestRestart({ changes: ["model: sonnet → opus"] });
  await rt.settled();
  expect(driver.starts).toHaveLength(2); // woken by restart_crons
  expect((await startReasons()).at(-1)).toBe("apply_changes");
  const [first] = batches(driver.last);
  expect(first).toHaveLength(2);
  expect(first).toContain(CONFIG);
  expect(first?.find((b) => b !== CONFIG)).toContain("every 5 minutes");
});

test("restartChanges shows while the restart is pending and clears on the exit", async () => {
  await idle();
  driver.last.emit(ev.turn());
  await rt.settled();
  await rt.requestRestart({ changes: ["model: sonnet → opus", "added skill release"] });
  await rt.requestRestart({ changes: ["added skill release"] });
  expect(rt.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["added skill release", "model: sonnet → opus"],
  });
  expect(rt.statusFrame().restartChanges).toEqual(["added skill release", "model: sonnet → opus"]);
  driver.last.emit(ev.usage(), ev.end());
  await rt.settled();
  expect(driver.last.stopped).toBe(true);
  expect(rt.live()).toMatchObject({ restartPending: false, restartChanges: [] });
  // A restart for another reason (credential, grants, manager) carries no lines.
  await send("again");
  driver.last.emit(...ev.fullTurn("sess-1"), ev.turn());
  await rt.settled();
  await rt.requestRestart();
  expect(rt.live()).toMatchObject({ restartPending: true, restartChanges: [] });
});

test("started is the effective config of the running process, cleared at its exit", async () => {
  await h.makeRuntime({ spec: (a) => okSpec(a, { model: "opus", warmWindowMinutes: 5 }) });
  ({ driver, rt, agentId } = h);
  expect(rt.started).toBeUndefined();
  await idle();
  expect(rt.started?.config).toMatchObject({ model: "opus", warmWindowMinutes: 5 });
  await rt.stop();
  expect(rt.started).toBeUndefined();
});

test("a start that resolves an image other than nextImage updates it and goes back through the pull", async () => {
  const slots = new RecordingSlots();
  let image = "img:v2";
  const ops: string[] = [];
  const containers: DockerDeps["containers"] = {
    ensure: async () => {
      ops.push("ensure");
      return { containerId: "c1", action: "created" as const, imageId: "sha256:img" };
    },
    stopIfRunning: async () => true,
    forceRemove: async () => true,
    remove: async () => true,
  };
  await h.makeRuntime({
    slots,
    nextImage: "img:v1",
    docker: { containers, claudeBin: "/usr/local/bin/claude" },
    spec: (a) => ({
      ...okSpec(a),
      runtime: "docker",
      effective: testEffective({ runtime: "docker", image }),
      launch: { image, mountCheck: {} as MountCheckContext },
    }),
  });
  ({ driver, rt, agentId } = h);
  await send("hi");
  expect(rt.nextImage).toBe("img:v2");
  expect(driver.starts).toHaveLength(0);
  expect(ops).toEqual([]); // no container for an image the Supervisor hasn't checked
  // The wake went back to the Supervisor (which pulls nextImage first); the slot was given back.
  expect(slots.events.filter(([k]) => k === "request")).toHaveLength(2);
  expect(slots.events).toContainEqual(["release"]);
  await rt.grant("message");
  await rt.settled();
  expect(driver.starts).toHaveLength(1);
  expect(ops).toEqual(["ensure"]);
  image = "img:v3"; // edited again before the next start: once more through the pull
  await rt.stop();
  await send("again");
  expect(rt.nextImage).toBe("img:v3");
  expect(driver.starts).toHaveLength(1);
});
