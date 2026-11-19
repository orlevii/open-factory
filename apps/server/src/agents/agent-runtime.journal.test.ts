import type { RuntimeJournal } from "@open-factory/db";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { ProcessJournal } from "../runtime/local/journal.ts";
import { mergeSnapshot, type ProcessPart } from "./agent-runtime.ts";
import { localCleanup } from "./runtimes.ts";
import { ev } from "./testing/fake-driver.ts";
import { RuntimeHarness } from "./testing/runtime-harness.ts";

const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
afterEach(() => {
  vi.useRealTimers();
});

const events = async () => (await h.store.after(h.agentId, 0, 1000)).map((e) => e.event);
const journalRow = async () => (await h.store.agentById(h.agentId))?.runtimeJournal ?? null;
const without = (j: RuntimeJournal | null) => {
  if (!j) return j;
  const { takenAt, ...rest } = j;
  expect(Number.isNaN(Date.parse(takenAt))).toBe(false);
  return rest;
};

const SNAP: ProcessPart = {
  claude: { pid: 4242, start: "C" },
  descendants: [{ pid: 5000, start: "S" }],
};

/**
 * A fake process journal over the real `localCleanup` and `ProcessJournal.reap`: `alive` holds the start time of every
 * "running" pid, `kills` every signal sent, `startsAtKill` how many processes had been started at each signal.
 */
function fakeJournal() {
  const alive = new Map<number, string>([[5000, "S"]]); // Claude itself is gone by the time anything reaps
  const kills: [number, string][] = [];
  const startsAtKill: number[] = [];
  const snapshot = vi.fn(async (_pid: number) => structuredClone(SNAP));
  const reaper = new ProcessJournal({
    startOf: async (pid) => alive.get(pid),
    kill: (pid, sig) => {
      if (!alive.has(pid)) throw new Error("ESRCH");
      kills.push([pid, sig]);
      startsAtKill.push(h.driver.starts.length);
      alive.delete(pid);
    },
    sleep: async () => {},
  });
  return { alive, kills, startsAtKill, snapshot, reaper };
}

async function makeRuntime(f = fakeJournal()) {
  await h.makeRuntime({
    journal: { snapshot: f.snapshot },
    cleanup: localCleanup(h.store, f.reaper),
  });
  return f;
}

/** A started, idle process on session sess-1. */
async function idle() {
  await h.send("hi");
  h.driver.last.emit(...ev.fullTurn("sess-1"));
  await h.rt.settled();
}

test("process_started snapshots Claude's tree into the journal", async () => {
  const f = await makeRuntime();
  await idle();
  expect(f.snapshot).toHaveBeenCalledWith(4242);
  expect(without(await journalRow())).toEqual({ ...SNAP, tasks: [], crons: [] });
});

test("the tasks/crons write merges with the process part, and background_task_started snapshots again", async () => {
  const f = await makeRuntime();
  await idle();
  f.snapshot.mockResolvedValueOnce({
    claude: SNAP.claude,
    descendants: [...SNAP.descendants, { pid: 5001, start: "T" }],
  });
  h.driver.last.emit(
    { type: "background_task_started", taskId: "t1", toolUseId: "u1", taskType: "local_bash" },
    ev.background([{ taskId: "t1", description: "pnpm test" }]),
  );
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(without(await journalRow())).toEqual({
    claude: SNAP.claude,
    descendants: [...SNAP.descendants, { pid: 5001, start: "T" }],
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
  });
});

test("snapshots every 10 s only while a turn is open or a task is live", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await makeRuntime();
  await idle();
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000); // idle: none
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(3);
  h.driver.last.emit(ev.end());
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(30_000);
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(3);
});

test("descendants are a union over the process's lifetime: one reparented away is still reaped", async () => {
  const f = fakeJournal();
  await makeRuntime(f);
  await idle(); // snapshot 1: {5000, S}
  f.snapshot.mockResolvedValueOnce({ claude: SNAP.claude, descendants: [] }); // reparented away
  h.driver.last.emit(ev.turn());
  h.driver.last.emit({
    type: "background_task_started",
    taskId: "t1",
    toolUseId: "u1",
    taskType: "local_bash",
  });
  await h.rt.settled();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(without(await journalRow())).toMatchObject({ descendants: SNAP.descendants });
  h.driver.last.exit(137);
  await h.rt.settled();
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
});

test("mergeSnapshot: a new start for a pid replaces it; a new Claude or process starts over", () => {
  const prev = {
    claude: { pid: 1, start: "C" },
    descendants: [
      { pid: 2, start: "A" },
      { pid: 3, start: "B" },
    ],
  };
  expect(
    mergeSnapshot(prev, {
      claude: { pid: 1, start: "C" },
      descendants: [
        { pid: 3, start: "B2" },
        { pid: 4, start: "D" },
      ],
    }),
  ).toEqual({
    claude: { pid: 1, start: "C" },
    descendants: [
      { pid: 2, start: "A" },
      { pid: 3, start: "B2" },
      { pid: 4, start: "D" },
    ],
  });
  const other = { claude: { pid: 1, start: "C2" }, descendants: [] };
  expect(mergeSnapshot(prev, other)).toEqual(other);
  expect(mergeSnapshot(undefined, other)).toEqual(other);
});

test("a new process's journal doesn't inherit the previous process's descendants", async () => {
  const f = await makeRuntime();
  await idle();
  await h.rt.stop({ graceMs: 0 });
  await h.rt.settled();
  f.snapshot.mockResolvedValueOnce({ claude: { pid: 4242, start: "C" }, descendants: [] });
  await h.send("again");
  await h.rt.settled();
  expect(without(await journalRow())).toMatchObject({ descendants: [] });
});

test("localCleanup names the DB when the journal read fails", async () => {
  const cleanup = localCleanup(
    {
      agentById: async () => {
        throw new Error("connection refused");
      },
    },
    { reap: async () => 0 },
  );
  await h.makeRuntime();
  const row = await h.store.agentById(h.agentId);
  if (!row) throw new Error("no row");
  await expect(cleanup(row)).rejects.toThrow(
    "Reading the runtime journal from the database failed",
  );
});

test("a failed snapshot is logged and never stops the agent", async () => {
  const f = fakeJournal();
  f.snapshot.mockRejectedValue(new Error("process 4242 is not running"));
  await makeRuntime(f);
  await idle();
  expect(h.rt.live().status).toBe("idle");
  expect(await journalRow()).toBeNull();
});

test("runtime: a mid-turn crash reaps the journal before the recovery start", async () => {
  const f = await makeRuntime();
  await idle();
  h.driver.last.emit(ev.turn());
  await h.rt.settled();
  h.driver.last.exit(137);
  await h.rt.settled();
  // Only the descendant whose start time still matches is signalled (Claude is gone), before the recovery starts.
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
  expect(f.startsAtKill).toEqual([1]);
  expect(h.driver.starts).toHaveLength(2);
  const evs = await events();
  expect(evs).toContainEqual({ type: "cleanup", killedProcesses: 1 });
  const types = evs.map((e) => e.type);
  expect(types.indexOf("cleanup")).toBeLessThan(types.lastIndexOf("process_started"));
});

test("an idle crash reaps and clears the journal", async () => {
  const f = await makeRuntime();
  await idle();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(h.rt.live().status).toBe("hibernated");
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
  expect(await journalRow()).toBeNull();
});

test("a crash keeps the journal's tasks after the reap but drops its pids", async () => {
  const f = await makeRuntime();
  await idle();
  h.driver.last.emit(ev.background([{ taskId: "t1", description: "pnpm test" }]));
  await h.rt.settled();
  f.snapshot.mockRejectedValue(new Error("gone")); // the recovery's snapshot fails: the reap's write shows
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
  expect(without(await journalRow())).toEqual({
    tasks: [{ taskId: "t1", description: "pnpm test" }],
    crons: [],
  });
});

test("nothing matches: no signal and no cleanup event", async () => {
  const f = fakeJournal();
  f.alive.clear();
  await makeRuntime(f);
  await idle();
  h.driver.last.exit(1);
  await h.rt.settled();
  expect(f.kills).toEqual([]);
  expect((await events()).map((e) => e.type)).not.toContain("cleanup");
});

test("a clean stop clears the journal without reaping", async () => {
  const f = await makeRuntime();
  await idle();
  await h.rt.stop({ graceMs: 0 });
  await h.rt.settled();
  expect(f.kills).toEqual([]);
  expect(await journalRow()).toBeNull();
});

test("an escalated stop reaps at its exit", async () => {
  const f = await makeRuntime();
  await idle();
  h.driver.last.stopResult = { code: null, signal: null, timedOut: true };
  h.driver.last.emitExitOnStop = false;
  await h.rt.hibernate("warm_window");
  await h.rt.settled();
  expect(h.driver.last.forceKilled).toBe(true);
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
  expect(await events()).toContainEqual({ type: "cleanup", killedProcesses: 1 });
  expect(await journalRow()).toBeNull();
  expect(h.rt.live().status).toBe("hibernated");
});

test("Restart of a stop_failed agent: the retry's SIGKILL exit reaps before the restart's wake", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await makeRuntime();
  await idle();
  const p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  const kill = p.forceKill;
  p.forceKill = async () => {
    p.forceKilled = true; // the first SIGKILL never produces an exit
  };
  await h.rt.hibernate("warm_window");
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(5_000);
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(f.kills).toEqual([]);

  p.forceKill = kill;
  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  expect(f.kills).toEqual([[5000, "SIGTERM"]]);
  expect(f.startsAtKill).toEqual([1]);
  expect(h.driver.starts).toHaveLength(2);
  expect(h.driver.last.sent[0]?.[0]?.body).toBe("Restarted by @or after an error.");
});

test("a failed cleanup at a Restart's exit is stop_failed with no wake, and keeps the pids", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fakeJournal();
  await h.makeRuntime({
    journal: { snapshot: f.snapshot },
    cleanup: async () => {
      throw new Error("db down");
    },
  });
  await idle();
  const p = h.driver.last;
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  const kill = p.forceKill;
  p.forceKill = async () => {
    p.forceKilled = true;
  };
  await h.rt.hibernate("warm_window");
  await h.rt.settled();
  await vi.advanceTimersByTimeAsync(5_000);
  await h.rt.settled();
  p.forceKill = kill;
  await h.rt.restart({ byHandle: "or", runtimeAllowed: true });
  await h.rt.settled();
  expect(h.rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(h.driver.starts).toHaveLength(1);
  const row = await h.store.agentById(h.agentId);
  expect(row?.attempting).toBe(false);
  expect(row?.runtimeJournal).toMatchObject({ claude: SNAP.claude });
});

test("localCleanup does nothing for a Docker agent or an empty journal", async () => {
  const reap = vi.fn(async () => 1);
  const cleanup = localCleanup(h.store, { reap });
  await h.makeRuntime();
  const row = await h.store.agentById(h.agentId);
  if (!row) throw new Error("no row");
  expect(await cleanup(row)).toBeUndefined(); // no journal
  await h.store.setRuntimeJournal(h.agentId, {
    ...SNAP,
    tasks: [],
    crons: [],
    takenAt: new Date().toISOString(),
  });
  expect(await cleanup({ ...row, runtime: "docker" })).toBeUndefined();
  expect(reap).not.toHaveBeenCalled();
  expect(await cleanup(row)).toEqual({ killedProcesses: 1 });
});
