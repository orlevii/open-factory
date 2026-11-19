import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AgentRuntime } from "./agent-runtime.ts";
import { AgentStartError } from "./errors.ts";
import type { EventStore } from "./event-store.ts";
import { ev, type FakeDriver, type FakeProcess } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

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
      await rt.compact({ byHandle: "or" });
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
  const p = send("queued").catch(() => {});
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
  const s = send("x").catch(() => {});
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
  const s = send("x").catch(() => {});
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
  const s = send("x").catch(() => {});
  await rt.settled();
  let open: () => void = () => {};
  h.prepareGate = new Promise<void>((r) => {
    open = r;
  });
  driver.starts[0]?.releaseStop();
  await vi.waitFor(() => expect(h.prepareCalls).toBe(2)); // the exit job is suspended in the respawn's prepare
  const stopping = rt.stop({ graceMs: 3000, termWaitMs: 10_000 });
  open();
  const outcome = await Promise.race([
    stopping.then(() => "stopped"),
    new Promise((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  await s;
  expect(outcome).toBe("stopped");
  expect(driver.starts).toHaveLength(1);
  expect(rt.live().status).toBe("hibernated");
  expect(rt.queueItems().map((i) => (i.kind === "message" ? i.body : i.kind))).toEqual(["x"]); // still pending for the next start
});

test("a shutdown landing while the restart's exit is being recorded never spawns", async () => {
  await idle();
  driver.last.holdStop = true;
  await rt.requestRestart();
  const s = send("x").catch(() => {});
  await rt.settled();
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let reached = false;
  const real = store.append.bind(store);
  const spy = vi.spyOn(store, "append").mockImplementation(async (...args) => {
    if (args[2].type === "exited") {
      reached = true;
      await gate;
    }
    return real(...args);
  });
  try {
    driver.starts[0]?.releaseStop();
    await vi.waitFor(() => expect(reached).toBe(true));
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
  const p = send("hi");
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
