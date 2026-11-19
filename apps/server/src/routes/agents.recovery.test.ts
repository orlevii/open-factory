import { afterAll, beforeAll, expect, test } from "vitest";
import type { AgentRuntime } from "../agents/agent-runtime.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const post = (url: string, payload?: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

let n = 0;
/** A fresh agent (its own slug) and its runtime. */
async function agent(): Promise<{ slug: string; rt: AgentRuntime }> {
  n += 1;
  const slug = `rec${n}`;
  await t.seedAgent({ slug });
  const rt = await t.app.runtimes.bySlug(slug);
  if (!rt) throw new Error("no runtime");
  return { slug, rt };
}
const send = async (slug: string, body: string) => {
  const r = await post(`/api/agents/${slug}/messages`, { body, urgent: false });
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
  await send(a.slug, "hi");
  lastProc(a.rt).emit({ type: "error", source: "resume", message });
  await a.rt.settled();
  expect(a.rt.live().status).toBe("errored");
  return a;
}

test("restart: 409 unless errored; errored → restart notice first, control event, one attempt", async () => {
  const healthy = await agent();
  const r0 = await post(`/api/agents/${healthy.slug}/restart`);
  expect(r0.statusCode).toBe(409);
  expect(r0.json().error.code).toBe("not_errored");
  expect((await post("/api/agents/nobody/restart")).statusCode).toBe(404);

  const { slug, rt } = await resumeErrored();
  expect(rt.live().errorKind).toBe("resume");
  const before = procsOf(rt).length;
  const r = await post(`/api/agents/${slug}/restart`);
  expect(r.statusCode).toBe(202);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(before + 1); // one attempt
  const p = lastProc(rt);
  expect(p.sent[0]?.map((m) => [m.from, m.body])).toEqual([
    ["@factory", "Restarted by @or after an error."],
    ["@or", "hi"],
  ]);
  const evs = await events(rt);
  const control = evs.findIndex((e) => e.type === "control" && e.cmd === "restart");
  expect(evs[control]).toEqual({ type: "control", cmd: "restart", by: "@or" });
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
  const { slug, rt } = await resumeErrored();
  expect((await post(`/api/agents/${slug}/restart`)).statusCode).toBe(202);
  await rt.settled();
  const again = await post(`/api/agents/${slug}/restart`);
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe("attempt_in_progress");
  const reset = await post(`/api/agents/${slug}/reset-session`);
  expect(reset.statusCode).toBe(409);
  expect(reset.json().error.code).toBe("attempt_in_progress");
  lastProc(rt).emit(ev.session(), ev.turn(), ev.end());
  await rt.settled();
});

test("restart of resume_unrecoverable: 409 with the new-session hint", async () => {
  const { slug, rt } = await resumeErrored("No conversation found with session ID sess-x");
  expect(rt.live().errorKind).toBe("resume_unrecoverable");
  const r = await post(`/api/agents/${slug}/restart`);
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toEqual({
    code: "resume_unrecoverable",
    message: "This session can't be resumed. Start a new session instead.",
  });
});

test("restart with the local runtime gate off: 409 runtime_disabled", async () => {
  const { slug } = await resumeErrored();
  const config = t.app.config as { allowLocalRuntime: boolean };
  config.allowLocalRuntime = false;
  try {
    const r = await post(`/api/agents/${slug}/restart`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("runtime_disabled");
  } finally {
    config.allowLocalRuntime = true;
  }
});

test("restart of stop_failed reuses its slot; a failed second escalation stays stop_failed with no wake", async () => {
  const { slug, rt } = await agent();
  await send(slug, "hi");
  const p = lastProc(rt);
  p.emit(...ev.fullTurn());
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
  expect((await post(`/api/agents/${slug}/restart`)).statusCode).toBe(202);
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
  expect((await post(`/api/agents/${slug}/restart`)).statusCode).toBe(202);
  await rt.settled();
  expect(procsOf(rt)).toHaveLength(2);
  expect(t.app.runtimes.supervisor.running().count).toBe(running);
  const evs = await events(rt);
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "restart",
  });
  const p2 = lastProc(rt);
  expect(p2.sent[0]?.[0]).toMatchObject({ from: "@factory" });
  p2.emit(ev.session(), ev.turn(), ev.end());
  await rt.settled();
  expect(rt.live().status).toBe("idle");
});

test("reset-session: clears session_id, appends session_reset, deletes pending notices, delivers pending human messages as the first turn without --resume", async () => {
  const { slug, rt } = await agent();
  await send(slug, "hi");
  lastProc(rt).emit(...ev.fullTurn("sess-A"));
  await rt.settled();
  await rt.hibernate("apply_changes");
  await rt.settled();
  await send(slug, "again");
  expect(lastProc(rt).opts.resumeSessionId).toBe("sess-A");
  lastProc(rt).emit({
    type: "error",
    source: "resume",
    message: "No conversation found with session ID sess-A",
  });
  await rt.settled();
  expect(rt.live().errorKind).toBe("resume_unrecoverable");
  await rt.postNotice("restart", "Restarted by @or after an error.");
  const before = procsOf(rt).length;

  const r = await post(`/api/agents/${slug}/reset-session`);
  expect(r.statusCode).toBe(202);
  await rt.settled();
  expect(await row(rt)).toMatchObject({ session_id: null, status: "hibernated" });
  const evs = await events(rt);
  expect(evs).toContainEqual({ type: "session_reset", by: "@or" });
  expect(procsOf(rt)).toHaveLength(before + 1);
  const p = lastProc(rt);
  expect(p.opts.resumeSessionId).toBeUndefined();
  expect(p.sent[0]?.map((m) => m.body)).toEqual(["again"]);
  expect(evs.filter((e) => e.type === "process_started").at(-1)).toMatchObject({
    reason: "reset",
    resumed: false,
  });
  const pendingNotices = await t.sql`
    select id from messages where to_agent_id = ${rt.agent.id} and kind = 'system' and state = 'pending'`;
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
  const r0 = await post(`/api/agents/${healthy.slug}/reset-session`);
  expect(r0.statusCode).toBe(409);
  expect(r0.json().error.code).toBe("reset_not_allowed");

  // Errored by a crash (the automatic attempt failed too): Restart, not a new session.
  const crashed = await agent();
  await send(crashed.slug, "hi");
  lastProc(crashed.rt).emit(...ev.fullTurn(), ev.turn());
  lastProc(crashed.rt).exit(137);
  await crashed.rt.settled();
  lastProc(crashed.rt).exit(1); // the recovery attempt crashes too
  await crashed.rt.settled();
  expect(crashed.rt.live()).toMatchObject({ status: "errored", errorKind: "crash" });
  const r1 = await post(`/api/agents/${crashed.slug}/reset-session`);
  expect(r1.statusCode).toBe(409);
  expect(r1.json().error.code).toBe("reset_not_allowed");

  // An ordinary resume failure: allowed.
  const { slug, rt } = await resumeErrored();
  const r2 = await post(`/api/agents/${slug}/reset-session`);
  expect(r2.statusCode).toBe(202);
  await rt.settled();
  expect(rt.live().errorKind).toBeUndefined();
  expect(lastProc(rt).opts.resumeSessionId).toBeUndefined();
});
