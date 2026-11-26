import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AgentRuntime } from "./agent-runtime.ts";
import { AgentArchivedError, AgentTerminatedError, RecoveryRefusedError } from "./errors.ts";
import type { EventStore } from "./event-store.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

const h = new RuntimeHarness();
let store: EventStore;
beforeAll(async () => {
  await h.setup();
  store = h.store;
});
afterAll(() => h.close());

let rt: AgentRuntime;
beforeEach(async () => {
  rt = await h.makeRuntime();
});

const call = (o: Partial<Parameters<AgentRuntime["restartNow"]>[0]> = {}) =>
  rt.restartNow({ by: "@lead", force: false, changes: [], runtimeAllowed: true, ...o });
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RecoveryRefusedError);
  return e as RecoveryRefusedError;
};
const types = async () => (await store.after(h.agentId, 0, 1000)).map((e) => e.event.type);
const bodies = () => rt.queueItems().flatMap((i) => (i.kind === "notice" ? [i.body] : []));
/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await rt.settled();
}

test("row 1: a terminated or archived target is refused with its own error", async () => {
  rt.markTerminated({ committed: true });
  await expect(call()).rejects.toBeInstanceOf(AgentTerminatedError);
  rt = await h.makeRuntime();
  rt.markArchived();
  await expect(call()).rejects.toBeInstanceOf(AgentArchivedError);
});

test("row 2: a process that hasn't confirmed its session is starting", async () => {
  await h.send("hi"); // spawned, no session_started yet
  const e = await refusal(call());
  expect(e).toMatchObject({
    code: "starting",
    message: `@${rt.agent.handle} is starting; try again shortly.`,
  });
  expect(h.driver.last.stopped).toBe(false);
});

test("row 3: a warm hibernate under way is stopping", async () => {
  await idle();
  h.driver.last.holdStop = true;
  await rt.hibernate("warm_window");
  const e = await refusal(call());
  expect(e).toMatchObject({
    code: "stopping",
    message: `@${rt.agent.handle} is stopping; try again shortly.`,
  });
  h.driver.last.releaseStop();
  await rt.settled();
});

test("row 3: Stop crons under way is stopping", async () => {
  await idle();
  h.driver.last.emit(ev.cron("c1"));
  await rt.settled();
  h.driver.last.holdStop = true;
  await rt.stopCrons("or");
  expect((await refusal(call())).code).toBe("stopping");
  h.driver.last.releaseStop();
  await rt.settled();
});

test("row 4: a compaction is compacting", async () => {
  await idle();
  await rt.compact({ by: "<@or>" });
  const e = await refusal(call());
  expect(e).toMatchObject({
    code: "compacting",
    message: `@${rt.agent.handle} is compacting; try again when it finishes.`,
  });
});

test("row 5: a session that can't be resumed is refused, even for a forced restart", async () => {
  rt = await h.makeRuntime({ errorKind: "resume_unrecoverable", status: "errored" });
  const e = await refusal(call({ force: true }));
  expect(e).toMatchObject({
    code: "resume_unrecoverable",
    message: `@${rt.agent.handle}'s session can't be resumed; a human must start a new session.`,
  });
  expect(h.driver.starts).toHaveLength(0);
});

test("row 6: an errored target restarts with the waking notice naming who restarted it", async () => {
  rt = await h.makeRuntime({ errorKind: "resume", status: "errored", sessionId: "sess-1" });
  expect(await call()).toEqual({ status: "restarting" });
  await rt.settled();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.driver.last.opts.resumeSessionId).toBe("sess-1");
  expect(h.driver.last.sent[0]?.[0]?.body).toBe("Restarted by @lead after an error.");
  expect(await types()).toContain("control");
});

test("row 6: a stop_failed target retries its stop instead of being refused as stopping", async () => {
  let fail = true;
  const cleanup = vi.fn(async () => {
    if (fail) throw new Error("docker down");
    return { container: "stopped" as const };
  });
  rt = await h.makeRuntime({ cleanup });
  await idle();
  h.driver.last.emit(ev.turn());
  h.driver.last.exit(1);
  await rt.settled();
  expect(rt.live().errorKind).toBe("stop_failed");
  fail = false;
  expect(await call()).toEqual({ status: "restarting" });
  await rt.settled();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(h.driver.starts).toHaveLength(2);
});

test("row 6: an errored local target is refused when the factory disables the local runtime", async () => {
  rt = await h.makeRuntime({ errorKind: "resume", status: "errored" });
  expect((await refusal(call({ runtimeAllowed: false }))).code).toBe("runtime_disabled");
  expect(h.driver.starts).toHaveLength(0);
});

test("row 7: a hibernated target has nothing to restart", async () => {
  expect(await call()).toEqual({ status: "not_running" });
  await idle();
  await rt.hibernate("warm_window");
  await rt.settled();
  expect(await call()).toEqual({ status: "not_running" });
  expect(h.driver.starts).toHaveLength(1);
});

test("row 8: lost work refuses without force, names it, and leaves the target running", async () => {
  await idle();
  h.driver.last.emit(
    ev.background([
      { taskId: "t1", description: "pnpm test" },
      { taskId: "t2", description: "vite dev" },
    ]),
    ev.cron("c1", { humanSchedule: "every 5 minutes" }),
  );
  await rt.settled();
  const e = await refusal(call());
  expect(e).toMatchObject({
    code: "lost_work",
    message: `@${rt.agent.handle} has 2 background tasks (\`pnpm test\`, \`vite dev\`) and 1 cron; pass force: true to restart anyway.`,
    data: { tasks: ["pnpm test", "vite dev"], crons: ["every 5 minutes"] },
  });
  expect(rt.live().status).not.toBe("errored");
  expect(h.driver.last.stopped).toBe(false);
  // Still serving: the refusal went through apiJob without erroring the agent.
  expect(await types()).not.toContain("error");
  expect(rt.live().errorKind).toBeUndefined();
});

test.each([
  ["row 9 (turn work)", (p: ReturnType<typeof pick>) => p.emit(ev.turn()), {}],
  [
    "row 10 (lost work, forced)",
    (p: ReturnType<typeof pick>) => p.emit(ev.background([{ taskId: "t1" }])),
    { force: true },
  ],
])(
  "%s: a local target is refused when the factory disables the local runtime",
  async (_n, setup, o) => {
    await idle();
    setup(pick());
    await rt.settled();
    expect((await refusal(call({ ...o, runtimeAllowed: false }))).code).toBe("runtime_disabled");
    expect(h.driver.last.stopped).toBe(false);
  },
);
const pick = () => h.driver.last;

test("row 11: owed notifications only set restart-when-idle and say so", async () => {
  await idle();
  h.driver.last.emit(ev.taskFinished("t1"), ev.background([]));
  await rt.settled();
  const out = await call({ changes: ["model: a → b"] });
  expect(out).toEqual({
    status: "restart_pending",
    note: `@${rt.agent.handle} restarts in a moment, once a finished task's result is delivered.`,
  });
  expect(rt.live()).toMatchObject({ restartPending: true, restartChanges: ["model: a → b"] });
  expect(h.driver.last.stopped).toBe(false);
});

test("row 12: an idle target hibernates and gets a passive config_changed with the lines", async () => {
  await idle();
  expect(await call({ changes: ["model: a → b", "added skill x"] })).toEqual({
    status: "restarted_idle",
  });
  await rt.settled();
  expect(h.driver.starts[0]?.stopped).toBe(true);
  expect(rt.live().status).toBe("hibernated");
  expect(bodies()).toEqual(["Your configuration changed:\n- added skill x\n- model: a → b"]);
  expect(h.driver.starts).toHaveLength(1); // passive: nothing woke it
});

test("row 12: no changes means no notice, and the local runtime being disabled doesn't matter", async () => {
  await idle();
  expect(await call({ changes: [], runtimeAllowed: false })).toEqual({ status: "restarted_idle" });
  await rt.settled();
  expect(rt.live().status).toBe("hibernated");
  expect(bodies()).toEqual([]);
  expect(await call({ changes: null })).toEqual({ status: "not_running" });
});

// Rows 9 and 10: the cut restart (§9.2.1). Everything is asserted on what the fake process received.
/** The bodies of the first batch the process in `n` was sent. */
const firstBatch = (n: number) => h.driver.starts[n]?.sent[0]?.map((m) => m.body);
const writeCount = () => h.driver.last.writes.length;
/** A turn that is open on the current process (the message that started it was written). */
async function midTurn() {
  await idle();
  await h.send("work");
  h.driver.last.emit(ev.turn());
  await rt.settled();
}
const finishTurn = async () => {
  h.driver.last.emit(ev.usage(), ev.end({ terminalReason: "aborted_streaming" }));
  await rt.settled();
};
const control = async (cmd: string) =>
  (await store.after(h.agentId, 0, 1000))
    .map((e) => e.event)
    .filter((e) => e.type === "control" && e.cmd === cmd);

test("row 9, mid-turn: interrupts, writes nothing to the old process, then resumes with the notice first", async () => {
  await midTurn();
  const old = h.driver.last;
  expect(await call({ changes: ["model"] })).toEqual({ status: "restarting" });
  expect(old.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  expect(old.stopped).toBe(false); // waits for the turn's end
  await h.send("later"); // queued meanwhile
  const written = writeCount();
  await finishTurn();
  expect(old.writes).toHaveLength(written); // not even after turn_end
  expect(old.stopped).toBe(true);
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.opts.resumeSessionId).toBe("sess-1");
  expect(firstBatch(1)).toEqual([
    "Restarted by @lead to apply: model. Continue where you left off.",
    "later",
  ]);
  expect(await control("restart")).toEqual([{ type: "control", cmd: "restart", by: "@lead" }]);
});

test("row 9: an existing Stop hold is reused: one interrupt control is written", async () => {
  await midTurn();
  await rt.interrupt({ by: "<@or>" });
  await call();
  expect(h.driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  await finishTurn();
  expect(h.driver.starts[0]?.stopped).toBe(true);
});

test("row 9: a batch written whose turn starts later is interrupted at turn_started", async () => {
  await idle();
  await h.send("x"); // written, awaiting its turn
  await call();
  expect(h.driver.last.controls).toEqual([]);
  expect(h.driver.last.stopped).toBe(false);
  h.driver.last.emit(ev.turn());
  await rt.settled();
  expect(h.driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  await finishTurn();
  expect(h.driver.starts[0]?.stopped).toBe(true);
});

test("row 9: a batch whose turn never starts: the fallback stops, and its rows are redelivered", async () => {
  await idle();
  await h.send("lost?");
  const old = h.driver.last;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await call();
    expect(old.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(250); // holdTimeoutMs is 200 in the harness
  } finally {
    vi.useRealTimers();
  }
  await rt.settled();
  expect(old.stopped).toBe(true);
  expect(old.controls).toEqual([]);
  expect(h.driver.starts).toHaveLength(2);
  expect(firstBatch(1)?.at(0)).toMatch(/^Restarted by @lead\./);
  expect(firstBatch(1)).toContain("lost?");
});

test("row 9: a raw command written with no turn open is stopped at once, with no interrupt", async () => {
  await idle();
  await rt.rawInput({ text: "/context", by: "@or", userId: "u1" });
  expect(h.driver.last.writes.some((w) => w.kind === "raw")).toBe(true);
  const old = h.driver.last;
  await call();
  await rt.settled();
  expect(old.controls).toEqual([]);
  expect(old.stopped).toBe(true);
  expect(h.driver.starts).toHaveLength(2);
});

test("row 10: an idle target with a live task and force stops without an interrupt, naming the task", async () => {
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await rt.settled();
  const old = h.driver.last;
  expect(await call({ force: true })).toEqual({ status: "restarting" });
  await rt.settled();
  expect(old.controls).toEqual([]);
  expect(old.stopped).toBe(true);
  expect(firstBatch(1)?.[0]).toContain("pnpm test");
  const lost = (await store.after(h.agentId, 0, 1000))
    .map((e) => e.event)
    .find((e) => e.type === "background_work_lost");
  expect(lost).toMatchObject({ reason: "restart", tasks: [{ taskId: "t1" }] });
});

test("row 9: a task started during the interrupt window is killed and reported", async () => {
  await midTurn();
  await call();
  h.driver.last.emit(ev.background([{ taskId: "t9", description: "vite dev" }]));
  await rt.settled();
  await finishTurn();
  expect(firstBatch(1)?.[0]).toContain("vite dev");
  const lost = (await store.after(h.agentId, 0, 1000))
    .map((e) => e.event)
    .find((e) => e.type === "background_work_lost");
  expect(lost).toMatchObject({ tasks: [{ taskId: "t9" }] });
});

test("stop() for an archive during the interrupt wins: no restart attempt is made", async () => {
  await midTurn();
  await call();
  rt.markArchived();
  await rt.stop();
  expect(h.driver.starts).toHaveLength(1);
  expect(h.driver.starts[0]?.stopped).toBe(true);
  const events = (await store.after(h.agentId, 0, 1000)).map((e) => e.event);
  expect(events.find((e) => e.type === "hibernated")).toMatchObject({ reason: "archived" });
  expect(events.some((e) => e.type === "control" && e.cmd === "restart")).toBe(false);
});

test("a second restartNow while pending returns restarting, replaces by, and interrupts once", async () => {
  await midTurn();
  await call({ by: "@lead", changes: ["model"] });
  expect(await call({ by: "@boss", changes: ["skill"] })).toEqual({ status: "restarting" });
  expect(h.driver.last.controls).toEqual([{ kind: "control", cmd: "interrupt" }]);
  await finishTurn();
  expect(firstBatch(1)?.[0]).toBe(
    "Restarted by @boss to apply: skill. Continue where you left off.",
  );
});

test("a second restartNow after the stop began is refused as starting", async () => {
  await midTurn();
  await call();
  h.driver.last.holdStop = true;
  await finishTurn(); // the stop has begun and is held
  expect(h.driver.last.stopped).toBe(true);
  expect((await refusal(call())).code).toBe("starting");
  h.driver.starts[0]?.releaseStop();
  await rt.settled();
});

test("only the write guard protects the old process: an awaiting batch, no hold yet", async () => {
  await idle();
  await h.send("x"); // written, awaiting its turn
  const old = h.driver.last;
  await call();
  const written = old.writes.length;
  await h.send("two");
  await h.send("three", true);
  await rt.addNotice("compact_continue", "n");
  await rt.settled();
  expect(old.writes).toHaveLength(written);
});

test("a cut restart that throws ends its attempt before the error is rethrown", async () => {
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1" }]));
  await rt.settled();
  const spy = vi.spyOn(store, "setAttempting").mockRejectedValueOnce(new Error("db down"));
  await expect(call({ force: true })).rejects.toThrow("db down");
  spy.mockRestore();
  await rt.settled();
  // Not wedged: the next call isn't refused as starting, and the row isn't left attempting.
  expect((await call({ force: true })).status).toBe("restarting");
  await rt.settled();
  h.driver.last.emit(...ev.fullTurn("sess-2")); // the new process runs a turn: the attempt is over
  await rt.settled();
  const row = await h.t.sql`select attempting from agents where id = ${h.agentId}`;
  expect(row[0]?.attempting).toBe(false);
});

test("the stop of a cut restart does nothing once the agent is terminated", async () => {
  await idle();
  await h.send("x"); // awaiting, so the stop waits for the fallback
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await call();
    rt.markTerminated({ committed: true });
    await vi.advanceTimersByTimeAsync(250);
  } finally {
    vi.useRealTimers();
  }
  await rt.settled();
  expect(await control("restart")).toEqual([]);
});

test("no delivery or notice writes to the old process while a cut restart is pending", async () => {
  await midTurn();
  await call();
  const written = writeCount();
  await h.send("one");
  await h.send("two", true); // urgent: no second interrupt either
  await rt.addNotice("compact_continue", "n");
  await rt.settled();
  expect(h.driver.last.writes).toHaveLength(written);
  await finishTurn();
  expect(firstBatch(1)).toEqual(expect.arrayContaining(["one", "two"]));
});
