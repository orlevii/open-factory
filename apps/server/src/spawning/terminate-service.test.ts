import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { AgentTerminatedError } from "../agents/errors.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { peerLeftOf } from "../messaging/peer-body.ts";
import { makeTestApp } from "../test/helpers.ts";

type T = Awaited<ReturnType<typeof makeTestApp>>;
let t: T | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
  t = undefined;
});

const writeTemplate = (home: string, name: string, y: string) => {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), y);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
};

/** A spawner `lead` (granted project app, may spawn `dev`, which asks for app) and `pm`, which reports to lead. */
async function setup() {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver });
  const app = t;
  const projectId = randomUUID();
  await app.db.insert(schema.projects).values({
    id: projectId,
    name: "app",
    hostPath: mkdtempSync(path.join(tmpdir(), "of-app-")),
  });
  writeTemplate(
    app.factoryHome,
    "dev",
    "name: dev\ndisplay_name: Dev\nruntime: local\nprojects:\n  - app\n",
  );
  const lead = await app.seedAgent({
    slug: "lead",
    config: { canSpawn: ["dev"], maxLiveSpawns: 5 },
  });
  await app.db.insert(schema.agentProjectGrants).values({ agentId: lead.id, projectId });
  const pm = await app.seedAgent({ slug: "pm" });
  await app.db.update(schema.agents).set({ reportsTo: lead.id }).where(eq(schema.agents.id, pm.id));
  return { t: app, driver, lead, pm };
}

/** Spawns `dev-<suffix>` from `spawner`, lets its brief start it, and ends its first turn: a started, idle child. */
async function spawnIdle(app: T, driver: FakeDriver, spawner: AgentRow, suffix: string) {
  const r = await app.app.spawner.spawn(
    spawner.id,
    { template: "dev", description: "Does the work", prompt: "Do it", suffix },
    null,
  );
  if (!r.ok) throw new Error(r.message);
  const rt = await app.app.runtimes.load(r.agentId);
  if (!rt) throw new Error("no runtime");
  await rt.settled();
  const proc = driver.starts.find((p) => p.spec.agentId === r.agentId) as FakeProcess;
  proc.emit(...ev.fullTurn(`sess-${suffix}`));
  await rt.settled();
  return { id: r.agentId, slug: r.slug, rt, proc };
}

const rowsTo = (app: T, agentId: string, kind: "peer_left" | "peer_joined" | "member_update") =>
  app.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.toAgentId, agentId), eq(schema.messages.kind, kind)));
const grantsOf = (app: T, agentId: string) =>
  app.db
    .select()
    .from(schema.agentProjectGrants)
    .where(eq(schema.agentProjectGrants.agentId, agentId));
const stateOf = async (app: T, id: string) =>
  (await app.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]?.state;

test("terminate: one transaction (row, grants, peer rows), the stop job, and nothing forwarded after", async () => {
  const { t, driver, lead, pm } = await setup();
  const child = await spawnIdle(t, driver, lead, "x1");
  expect(await grantsOf(t, child.id)).toHaveLength(1);

  expect(await t.app.terminator.terminate(child.id, "@or")).toEqual({ status: "terminated" });
  const row = await t.app.store.agentById(child.id);
  expect(row).toMatchObject({ terminatedBy: "@or", attempting: false });
  expect(row?.terminatedAt).toBeInstanceOf(Date);
  expect(await grantsOf(t, child.id)).toEqual([]);
  expect(child.rt.isTerminated()).toBe(true);
  expect(t.app.runtimes.statusOf({ id: child.id, status: "hibernated" })).toBe("terminated");

  await child.rt.settled();
  expect(child.proc.stopped).toBe(true);
  const evs = (await t.app.store.after(child.id, 0, 1000)).map((e) => e.event);
  expect(evs.filter((e) => e.type === "terminated")).toEqual([{ type: "terminated", by: "@or" }]);

  // A human terminated it: the spawner hears it as a report, its other report as a peer; both bodies round-trip.
  const toLead = await rowsTo(t, lead.id, "peer_left");
  expect(toLead).toEqual([
    expect.objectContaining({ subjectAgentId: child.id, notice: "report", state: "pending" }),
  ]);
  expect(peerLeftOf(toLead[0]?.body ?? "")).toEqual({ reason: "terminated", by: "@or" });
  expect(toLead[0]?.body).toBe(`@${child.slug} (Dev · x1) left: terminated by @or.`);
  expect(await rowsTo(t, pm.id, "peer_left")).toEqual([
    expect.objectContaining({ subjectAgentId: child.id, notice: "peer" }),
  ]);

  // A forward racing the commit writes nothing: the Router re-checks the row in its own transaction.
  const before = await rowsTo(t, lead.id, "member_update");
  await t.app.router.forward({ agentId: child.id, body: "a late report" });
  expect(await rowsTo(t, lead.id, "member_update")).toEqual(before);
});

test("terminate_agent: only your own spawned agents; idempotent; persistent agents refuse", async () => {
  const { t, driver, lead, pm } = await setup();
  const other = await t.seedAgent({ slug: "other", config: { canSpawn: ["dev"] } });
  const child = await spawnIdle(t, driver, lead, "x2");
  const notYours = (slug: string) => ({
    ok: false,
    message: `@${slug} isn't an agent you spawned.`,
  });
  expect(await t.app.terminator.terminateChild(other.id, child.slug)).toEqual(notYours(child.slug));
  expect(await t.app.terminator.terminateChild(lead.id, "pm")).toEqual(notYours("pm"));
  expect(await t.app.terminator.terminateChild(lead.id, "@nobody")).toEqual(notYours("nobody"));
  expect((await t.app.store.agentById(child.id))?.terminatedAt).toBeNull();

  expect(await t.app.terminator.terminateChild(lead.id, ` @${child.slug} `)).toEqual({
    ok: true,
    slug: child.slug,
  });
  expect(await t.app.terminator.terminateChild(lead.id, child.slug)).toEqual({
    ok: true,
    slug: child.slug,
  });
  // The spawner is recorded by its slug (spec §13).
  expect((await t.app.store.agentById(child.id))?.terminatedBy).toBe("lead");
  await child.rt.settled();
  const evs = (await t.app.store.after(child.id, 0, 1000)).map((e) => e.event);
  expect(evs.filter((e) => e.type === "terminated")).toHaveLength(1);

  await expect(t.app.terminator.terminate(pm.id, "@or")).rejects.toMatchObject({
    status: 409,
    code: "not_ephemeral",
  });
});

test("the spawner gets no peer row about its own terminate; the other reports do", async () => {
  const { t, driver, lead, pm } = await setup();
  const a = await spawnIdle(t, driver, lead, "aa");
  const b = await spawnIdle(t, driver, lead, "bb");
  await t.app.terminator.terminateChild(lead.id, a.slug);
  expect(await rowsTo(t, lead.id, "peer_left")).toEqual([]);
  for (const id of [b.id, pm.id]) {
    const rows = await rowsTo(t, id, "peer_left");
    expect(rows).toEqual([expect.objectContaining({ subjectAgentId: a.id, notice: "peer" })]);
    expect(rows[0]?.body).toBe(`@${a.slug} (Dev · aa) left: terminated by @lead.`);
  }
});

test("pending rows to it are rejected; its own pending updates to the spawner still go out", async () => {
  const { t, driver, lead } = await setup();
  const { user } = await t.signUpUser();
  const a = await spawnIdle(t, driver, lead, "ca");
  await spawnIdle(t, driver, lead, "cb"); // a's peer_joined about cb: held, never due alone
  const [peerRow] = await rowsTo(t, a.id, "peer_joined");
  expect(peerRow?.state).toBe("pending");
  // A direct message committed but not yet handed over when the termination commits.
  const direct = await t.app.store.createMessage({
    from: { userId: user.id },
    toAgentId: a.id,
    body: "are you there?",
    urgent: false,
  });
  // a's own report to its spawner, held in lead's debounce window.
  a.proc.emit(ev.turn(), ev.text("done with it"), ev.end());
  await a.rt.settled();
  const [update] = await rowsTo(t, lead.id, "member_update");
  expect(update).toMatchObject({ fromAgentId: a.id, state: "pending" });

  await t.app.terminator.terminate(a.id, "@or");
  expect(await stateOf(t, peerRow?.id ?? "")).toBe("rejected");
  expect(await stateOf(t, direct.id)).toBe("rejected");
  expect(await stateOf(t, update?.id ?? "")).toBe("pending");
  // The late hand-off of the direct message finds the committed latch.
  await expect(t.app.runtimes.deliver(direct, "human")).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  // A new send is refused by the Router.
  expect(
    await t.app.router.send({ userId: user.id, handle: user.handle }, a.slug, "hello?", false),
  ).toMatchObject({ ok: false, code: "terminated" });
});

test("a failed transaction undoes the provisional latch: what arrived meanwhile is delivered", async () => {
  const { t, driver, lead } = await setup();
  const { user } = await t.signUpUser();
  const child = await spawnIdle(t, driver, lead, "fx");
  const row = await t.app.store.createMessage({
    from: { userId: user.id },
    toAgentId: child.id,
    body: "meanwhile",
    urgent: false,
  });
  const original = t.app.store.terminateRows.bind(t.app.store);
  vi.spyOn(t.app.store, "terminateRows").mockImplementation(async (...a) => {
    // The provisional latch is set: the row is queued, not written and not rejected.
    await child.rt.deliver(row, { sender: "human", fromLabel: `@${user.handle}` });
    expect(child.proc.sent.flat().map((m) => m.body)).not.toContain("meanwhile");
    await original(...a);
    throw new Error("the database went away");
  });
  await expect(t.app.terminator.terminate(child.id, "@or")).rejects.toThrow(
    "the database went away",
  );
  expect(child.rt.isTerminated()).toBe(false);
  expect((await t.app.store.agentById(child.id))?.terminatedAt).toBeNull();
  await child.rt.settled();
  expect(child.proc.sent.flat().map((m) => m.body)).toContain("meanwhile");
  expect(child.proc.stopped).toBe(false);

  // Through the tool the failure is one sentence that says what to do.
  expect(await t.app.terminator.terminateChild(lead.id, child.slug)).toEqual({
    ok: false,
    message: `@${child.slug} couldn't be terminated; try again.`,
  });
  expect(child.rt.isTerminated()).toBe(false);
});
