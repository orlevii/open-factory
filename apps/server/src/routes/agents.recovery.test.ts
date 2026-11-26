import { tagOf } from "@open-factory/shared/tags";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { makeTestApp, runtimeOf } from "../test/helpers.ts";
import { testRef, UNKNOWN_REF } from "../test/principals.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
/** The signed-in human's tag: the factory-written texts and control events name it that way. */
let orTag = "";
let orAgentTag = "";
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  const signedUp = await t.signUpUser({ handle: "or" });
  cookie = signedUp.cookie;
  orTag = tagOf(testRef(signedUp.user.id));
  orAgentTag = `<@${testRef(signedUp.user.id)}|or>`;
});
afterAll(() => t.close());

const post = (url: string, payload?: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

let n = 0;
/** A fresh agent (its own handle) and its runtime. */
async function agent(): Promise<{ handle: string; rt: AgentRuntime }> {
  n += 1;
  const handle = `rec${n}`;
  await t.seedAgent({ handle });
  const rt = await runtimeOf(t.app, handle);
  if (!rt) throw new Error("no runtime");
  return { handle, rt };
}
const send = async (handle: string, body: string) => {
  const r = await post(`/api/messages`, { to: [handle], body, urgent: false });
  expect(r.statusCode).toBe(202);
};
const procsOf = (rt: AgentRuntime): FakeProcess[] =>
  driver.starts.filter((p) => p.spec.agentId === rt.agent.id);
const lastProc = (rt: AgentRuntime): FakeProcess => {
  const p = procsOf(rt).at(-1);
  if (!p) throw new Error("never started");
  return p;
};
const events = async (rt: AgentRuntime) =>
  (await t.app.store.after(rt.agent.id, 0, 1000)).map((e) => e.event);
const row = async (rt: AgentRuntime) =>
  (
    await t.sql`select status, error_kind, attempting, session_id from agents where id = ${rt.agent.id}`
  )[0];

/** Errored with an ordinary resume failure; "hi" stays pending. */
async function resumeErrored(message = "API Error: 500 overloaded") {
  const a = await agent();
  await send(a.handle, "hi");
  lastProc(a.rt).emit({ type: "error", source: "resume", message });
  await a.rt.settled();
  expect(a.rt.live().status).toBe("errored");
  return a;
}

test("restart: an errored agent gets the restart notice first, control event, one attempt", async () => {
  expect((await post(`/api/agents/${UNKNOWN_REF}/restart`)).statusCode).toBe(404);

  const { handle, rt } = await resumeErrored();
  expect(rt.live().errorKind).toBe("resume");
  const before = procsOf(rt).length;
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(r.statusCode).toBe(202);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(before + 1); // one attempt
  const p = lastProc(rt);
  expect(p.sent[0]?.map((m) => [m.from, m.body])).toEqual([
    ["@factory", `Restarted by ${orAgentTag} after an error.`],
    [orAgentTag, "hi"],
  ]);
  const evs = await events(rt);
  const control = evs.findIndex((e) => e.type === "control" && e.cmd === "restart");
  expect(evs[control]).toEqual({ type: "control", cmd: "restart", by: orTag });
  expect(evs.slice(control).find((e) => e.type === "process_started")).toMatchObject({
    reason: "restart",
  });
  expect(rt.live().status).not.toBe("errored"); // attempting
  expect(await row(rt)).toMatchObject({ status: "errored", attempting: true });
  p.emit(ev.session("sess-r"), ev.turn(), ev.end());
  await rt.settled();
  expect(rt.live().status).toBe("idle");
  expect(rt.live().errorKind).toBeUndefined();
  expect(await row(rt)).toMatchObject({
    status: "hibernated",
    error_kind: null,
    attempting: false,
  });
});

test("restart while an attempt runs: 409 attempt_in_progress", async () => {
  const { handle, rt } = await resumeErrored();
  expect((await post(`/api/agents/${await t.refOf(handle)}/restart`)).statusCode).toBe(202);
  await rt.settled();
  const again = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe("attempt_in_progress");
  const reset = await post(`/api/agents/${await t.refOf(handle)}/reset-session`);
  expect(reset.statusCode).toBe(409);
  expect(reset.json().error.code).toBe("attempt_in_progress");
  lastProc(rt).emit(ev.session(), ev.turn(), ev.end());
  await rt.settled();
});

test("restart of resume_unrecoverable: 409 with the new-session hint", async () => {
  const { handle, rt } = await resumeErrored("No conversation found with session ID sess-x");
  expect(rt.live().errorKind).toBe("resume_unrecoverable");
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toEqual({
    code: "resume_unrecoverable",
    message: `@${handle}'s session can't be resumed; a human must start a new session.`,
  });
});

test("restart with the local runtime gate off: 409 runtime_disabled", async () => {
  const { handle, rt } = await resumeErrored();
  const config = t.app.config as { allowLocalRuntime: boolean };
  expect(rt.live().runtimeDisabled).toBeUndefined();
  config.allowLocalRuntime = false;
  try {
    expect(rt.live().runtimeDisabled).toBe("The local runtime is disabled on this factory.");
    const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("runtime_disabled");
  } finally {
    config.allowLocalRuntime = true;
  }
});

test("restart of stop_failed releases its slot and the restart's wake follows; a failed second escalation stays stop_failed with no wake", async () => {
  const { handle, rt } = await agent();
  await send(handle, "hi");
  const p = lastProc(rt);
  p.emit(...ev.fullTurn(), ev.cron("c1", { humanSchedule: "every 5 minutes" }));
  await rt.settled();
  p.stopResult = { code: null, signal: null, timedOut: true };
  p.emitExitOnStop = false;
  p.forceKill = async () => {
    throw new Error("EPERM");
  };
  await rt.hibernate("apply_changes");
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  const running = t.app.runtimes.supervisor.running().count; // includes the slot it still holds

  // The second escalation fails too: still stop_failed, no wake, the slot still held.
  expect((await post(`/api/agents/${await t.refOf(handle)}/restart`)).statusCode).toBe(202);
  await rt.settled();
  expect(rt.live()).toMatchObject({ status: "errored", errorKind: "stop_failed" });
  expect(rt.live().lastError).toBe(
    "The agent's process can't be stopped. Check the host (pid 4242) or Docker, then restart again.",
  );
  expect(procsOf(rt)).toHaveLength(1);
  expect(t.app.runtimes.supervisor.running().count).toBe(running);
  expect(await row(rt)).toMatchObject({ error_kind: "stop_failed", attempting: false });
  expect((await events(rt)).filter((e) => e.type === "stop_escalated")).toHaveLength(2);

  // It succeeds: the slot comes back and the restart's wake takes it.
  p.forceKill = async () => {
    p.exit(137);
  };
  expect((await post(`/api/agents/${await t.refOf(handle)}/restart`)).statusCode).toBe(202);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(2);
  expect(t.app.runtimes.supervisor.running().count).toBe(running);
  const evs = await events(rt);
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "restart",
  });
  // The cron died with the stuck process: recorded at its exit, named in the notice.
  expect(evs).toContainEqual({
    type: "background_work_lost",
    reason: "restart",
    tasks: [],
    crons: [{ cronId: "c1", humanSchedule: "every 5 minutes" }],
  });
  const p2 = lastProc(rt);
  expect(p2.sent[0]?.[0]).toMatchObject({
    from: "@factory",
    body: `Restarted by ${orAgentTag} after an error. These crons were stopped: every 5 minutes.`,
  });
  p2.emit(ev.session(), ev.turn(), ev.end());
  await rt.settled();
  expect(rt.live().status).toBe("idle");
});

test("reset-session: clears session_id, appends session_reset, deletes pending notices, delivers pending human messages as the first turn without --resume", async () => {
  const { handle, rt } = await agent();
  await send(handle, "hi");
  lastProc(rt).emit(...ev.fullTurn("sess-A"));
  await rt.settled();
  await rt.hibernate("apply_changes");
  await rt.settled();
  await send(handle, "again");
  expect(lastProc(rt).opts.resumeSessionId).toBe("sess-A");
  lastProc(rt).emit({
    type: "error",
    source: "resume",
    message: "No conversation found with session ID sess-A",
  });
  await rt.settled();
  expect(rt.live().errorKind).toBe("resume_unrecoverable");
  await rt.postNotice("restart", `Restarted by ${orTag} after an error.`);
  const before = procsOf(rt).length;

  const r = await post(`/api/agents/${await t.refOf(handle)}/reset-session`);
  expect(r.statusCode).toBe(202);
  await rt.settled();
  expect(await row(rt)).toMatchObject({ session_id: null, status: "hibernated" });
  const evs = await events(rt);
  expect(evs).toContainEqual({ type: "session_reset", by: orTag });
  expect(procsOf(rt)).toHaveLength(before + 1);
  const p = lastProc(rt);
  expect(p.opts.resumeSessionId).toBeUndefined();
  expect(p.sent[0]?.map((m) => m.body)).toEqual(["again"]);
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "reset",
    resumed: false,
  });
  const pendingNotices = await t.sql`
    select id from messages where to_id = ${rt.agent.id} and kind = 'system' and state = 'pending'`;
  expect(pendingNotices).toHaveLength(0);
  p.emit(...ev.fullTurn("sess-B"));
  await rt.settled();
  expect(rt.live().status).toBe("idle");
  expect(await row(rt)).toMatchObject({
    session_id: "sess-B",
    error_kind: null,
    attempting: false,
  });
});

test("reset-session only for resume / resume_unrecoverable", async () => {
  const healthy = await agent();
  const r0 = await post(`/api/agents/${await t.refOf(healthy.handle)}/reset-session`);
  expect(r0.statusCode).toBe(409);
  expect(r0.json().error.code).toBe("reset_not_allowed");

  // Errored by a crash (the automatic attempt failed too): Restart, not a new session.
  const crashed = await agent();
  await send(crashed.handle, "hi");
  lastProc(crashed.rt).emit(...ev.fullTurn(), ev.turn());
  lastProc(crashed.rt).exit(137);
  await crashed.rt.settled();
  lastProc(crashed.rt).exit(1); // the recovery attempt crashes too
  await crashed.rt.settled();
  expect(crashed.rt.live()).toMatchObject({ status: "errored", errorKind: "crash" });
  const r1 = await post(`/api/agents/${await t.refOf(crashed.handle)}/reset-session`);
  expect(r1.statusCode).toBe(409);
  expect(r1.json().error.code).toBe("reset_not_allowed");

  // An ordinary resume failure: allowed.
  const { handle, rt } = await resumeErrored();
  const r2 = await post(`/api/agents/${await t.refOf(handle)}/reset-session`);
  expect(r2.statusCode).toBe(202);
  await rt.settled();
  expect(rt.live().errorKind).toBeUndefined();
  expect(lastProc(rt).opts.resumeSessionId).toBeUndefined();
});

/** Errored by a resume failure whose process is still there (its stop doesn't produce the exit yet). */
async function resumeErroredProcessLeft(message = "API Error: 500 overloaded") {
  const a = await agent();
  await send(a.handle, "hi");
  const p = lastProc(a.rt);
  p.emitExitOnStop = false;
  p.emit({ type: "error", source: "resume", message });
  await a.rt.settled();
  expect(a.rt.live().status).toBe("errored");
  expect(p.stopped).toBe(true);
  return { ...a, p };
}

test("restart with the failed start's process left: force stop, and its exit makes the one attempt", async () => {
  const { handle, rt, p } = await resumeErroredProcessLeft();
  expect((await post(`/api/agents/${await t.refOf(handle)}/restart`)).statusCode).toBe(202);
  await rt.settled();
  expect(await events(rt)).toContainEqual({ type: "control", cmd: "restart", by: orTag });
  expect(procsOf(rt)).toHaveLength(1); // nothing starts before the exit
  expect(await row(rt)).toMatchObject({ attempting: true });
  p.exit(0);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(2);
  const evs = await events(rt);
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "restart",
  });
  expect(evs.map((e) => e.type)).not.toContain("background_work_lost"); // nothing was live
  expect(lastProc(rt).sent[0]?.map((m) => [m.from, m.body])).toEqual([
    ["@factory", `Restarted by ${orAgentTag} after an error.`],
    [orAgentTag, "hi"],
  ]);
  lastProc(rt).emit(ev.session(), ev.turn(), ev.end());
  await rt.settled();
  expect(rt.live().status).toBe("idle");
});

test("reset-session with the failed start's process left: its exit starts the new session with the human messages", async () => {
  const { handle, rt, p } = await resumeErroredProcessLeft(
    "No conversation found with session ID sess-x",
  );
  await t.sql`update agents set session_id = 'sess-x' where id = ${rt.agent.id}`;
  expect((await post(`/api/agents/${await t.refOf(handle)}/reset-session`)).statusCode).toBe(202);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(1);
  expect(await row(rt)).toMatchObject({ attempting: true, session_id: null });
  p.exit(0);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(2);
  expect(lastProc(rt).opts.resumeSessionId).toBeUndefined();
  expect(lastProc(rt).sent[0]?.map((m) => m.body)).toEqual(["hi"]);
  expect((await events(rt)).filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "reset",
    resumed: false,
  });
});

test("reset-session with the process left and no human message: its exit starts nothing", async () => {
  // A compact started it (no human message pending); the resume failed and its process is still there.
  const { handle, rt } = await agent();
  expect((await post(`/api/agents/${await t.refOf(handle)}/compact`, {})).statusCode).toBe(202);
  const p = lastProc(rt);
  p.emitExitOnStop = false;
  p.emit({ type: "error", source: "resume", message: "API Error: 500 overloaded" });
  await rt.settled();
  expect(rt.live().errorKind).toBe("resume");
  expect((await post(`/api/agents/${await t.refOf(handle)}/reset-session`)).statusCode).toBe(202);
  await rt.settled();
  expect(await row(rt)).toMatchObject({ attempting: false });
  p.exit(0);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(1);
  expect(rt.live().status).not.toBe("errored");
  expect(await row(rt)).toMatchObject({ attempting: false, status: "hibernated" });
});

test("restart during a stop in progress: 503 agent_start_failed", async () => {
  const a = await agent();
  await send(a.handle, "hi");
  const p = lastProc(a.rt);
  p.holdStop = true;
  p.emit({ type: "error", source: "resume", message: "API Error: 500 overloaded" });
  await a.rt.settled();
  const stopping = a.rt.stop({ graceMs: 0 });
  const r = await post(`/api/agents/${await t.refOf(a.handle)}/restart`);
  expect(r.statusCode).toBe(503);
  expect(r.json().error).toEqual({
    code: "agent_start_failed",
    message: "The agent is being stopped.",
  });
  p.releaseStop();
  await stopping;
});

test("restart and reset-session of an archived agent: 409 agent_archived", async () => {
  const { handle } = await resumeErrored();
  expect((await post(`/api/agents/${await t.refOf(handle)}/archive`)).statusCode).toBe(200);
  for (const action of ["restart", "reset-session"]) {
    const r = await post(`/api/agents/${await t.refOf(handle)}/${action}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("agent_archived");
  }
});

/** Hibernates a test's agent so it stops counting against the supervisor's running-agent cap. */
const park = async (rt: AgentRuntime) => {
  await rt.hibernate("apply_changes");
  await rt.settled();
};

/** A running agent that has finished its first turn, with one live background task (lost work on a restart). */
async function runningWithBackgroundTask() {
  const a = await agent();
  await send(a.handle, "hi");
  lastProc(a.rt).emit(
    ...ev.fullTurn(),
    ev.background([{ taskId: "t1", description: "pnpm test" }]),
  );
  await a.rt.settled();
  expect(a.rt.live().status).toBe("idle");
  return a;
}

test("restart of a running agent with background work and no force: 409 lost_work, its tasks in error.data, nothing stopped", async () => {
  const { handle, rt } = await runningWithBackgroundTask();
  const before = procsOf(rt).length;
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatchObject({
    code: "lost_work",
    data: { tasks: ["pnpm test"], crons: [] },
  });
  expect(r.json().error.message).toContain("pass force: true");
  expect(procsOf(rt)).toHaveLength(before);
  expect(lastProc(rt).exited).toBe(false);
  await park(rt);
});

test("restart of a running agent with background work and force: true: 202 restarting, then a new process", async () => {
  const { handle, rt } = await runningWithBackgroundTask();
  const before = procsOf(rt).length;
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`, { force: true });
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ status: "restarting" });
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(before + 1);
  await park(rt);
});

test("restart of an idle running agent with nothing lost: 202 restarted_idle", async () => {
  const { handle, rt } = await agent();
  await send(handle, "hi");
  lastProc(rt).emit(...ev.fullTurn());
  await rt.settled();
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ status: "restarted_idle" });
  await park(rt);
});

test("restart of a hibernated agent: 202 not_running", async () => {
  const { handle, rt } = await agent();
  await send(handle, "hi");
  lastProc(rt).emit(...ev.fullTurn());
  await rt.settled();
  await rt.hibernate("warm_window");
  await rt.settled();
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`);
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ status: "not_running" });
  await park(rt);
});

test("restart with a force that isn't a boolean: 400", async () => {
  const { handle, rt } = await runningWithBackgroundTask();
  const r = await post(`/api/agents/${await t.refOf(handle)}/restart`, { force: "yes" });
  expect(r.statusCode).toBe(400);
  await park(rt);
});
