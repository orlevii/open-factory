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
    message: `@${rt.agent.slug} is starting; try again shortly.`,
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
    message: `@${rt.agent.slug} is stopping; try again shortly.`,
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
  await rt.compact({ byHandle: "or" });
  const e = await refusal(call());
  expect(e).toMatchObject({
    code: "compacting",
    message: `@${rt.agent.slug} is compacting; try again when it finishes.`,
  });
});

test("row 5: a session that can't be resumed is refused, even for a forced restart", async () => {
  rt = await h.makeRuntime({ errorKind: "resume_unrecoverable", status: "errored" });
  const e = await refusal(call({ force: true }));
  expect(e).toMatchObject({
    code: "resume_unrecoverable",
    message: `@${rt.agent.slug}'s session can't be resumed; a human must start a new session.`,
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
    message: `@${rt.agent.slug} has 2 background tasks (\`pnpm test\`, \`vite dev\`) and 1 cron; pass force: true to restart anyway.`,
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
    note: `@${rt.agent.slug} restarts in a moment, once a finished task's result is delivered.`,
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
