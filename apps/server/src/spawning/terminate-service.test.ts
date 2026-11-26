import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { AgentTerminatedError } from "../agents/errors.ts";
import { ev, FakeDriver, type FakeProcess } from "../agents/testing/fake-driver.ts";
import { callTool } from "../mcp/testing/mcp-client.ts";
import { peerLeftOf } from "../messaging/peer-body.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestUser } from "../test/principals.ts";
import { asRunning } from "../test/running.ts";

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
    config: { template: { can_spawn: ["dev"] } },
  });
  // I2 §6.2: spawning follows the spawner's running process.
  await asRunning(app.app, lead);
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
/**
 * Holds the termination's transaction open right after its `terminateRows` (locks taken, rows written, not committed):
 * `entered` resolves then, and `release()` lets it commit. `during` runs inside that window first.
 */
function holdTermination(app: T, during: () => Promise<void> = async () => {}) {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let enter!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const original = app.app.store.terminateRows.bind(app.app.store);
  vi.spyOn(app.app.store, "terminateRows").mockImplementation(async (...a) => {
    const rejected = await original(...a);
    await during();
    enter();
    await released;
    return rejected;
  });
  return { entered, release };
}

/** Resolves once another backend waits on a row lock in a query containing `like` (a `for no key update` one by default). */
async function lockWaiter(app: T, like = "for no key update") {
  for (;;) {
    const [w] = await app.sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ilike ${`%${like}%`}`;
    if ((w?.n ?? 0) >= 1) return;
  }
}

const stateOf = async (app: T, id: string) =>
  (await app.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]?.state;

test("terminate: one transaction (row, grants, peer rows), the stop job, and nothing forwarded after", async () => {
  const { t, driver, lead, pm } = await setup();
  const child = await spawnIdle(t, driver, lead, "x1");
  expect(await grantsOf(t, child.id)).toHaveLength(1);

  const or = await seedTestUser(t.db, "or");
  expect(await t.app.terminator.terminate(child.id, or)).toEqual({ status: "terminated" });
  const row = await t.app.store.agentById(child.id);
  expect(row).toMatchObject({ terminatedBy: or.id, attempting: false });
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
});

test("terminate_agent: only your own spawned agents; idempotent; persistent agents refuse", async () => {
  const { t, driver, lead, pm } = await setup();
  const other = await t.seedAgent({ slug: "other", config: { template: { can_spawn: ["dev"] } } });
  const child = await spawnIdle(t, driver, lead, "x2");
  const notYours = (slug: string) => ({
    ok: false,
    message: `@${slug} isn't an agent you spawned.`,
  });
  expect(await t.app.terminator.terminateChild(other.id, child.slug)).toEqual(notYours(child.slug));
  expect(await t.app.terminator.terminateChild(lead.id, "pm")).toEqual(notYours("pm"));
  expect(await t.app.terminator.terminateChild(lead.id, "@nobody")).toEqual(notYours("nobody"));
  expect((await t.app.store.agentById(child.id))?.terminatedAt).toBeNull();

  expect(await t.app.terminator.terminateChild(lead.id, ` @${child.slug} `)).toMatchObject({
    ok: true,
    slug: child.slug,
  });
  expect(await t.app.terminator.terminateChild(lead.id, child.slug)).toMatchObject({
    ok: true,
    slug: child.slug,
  });
  expect((await t.app.store.agentById(child.id))?.terminatedBy).toBe(lead.id);
  await child.rt.settled();
  const evs = (await t.app.store.after(child.id, 0, 1000)).map((e) => e.event);
  expect(evs.filter((e) => e.type === "terminated")).toHaveLength(1);

  await expect(
    t.app.terminator.terminate(pm.id, await seedTestUser(t.db, "or")),
  ).rejects.toMatchObject({
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
    recipients: ["@test"],
    body: "are you there?",
    urgent: false,
  });
  // a's own report to its spawner, held in lead's debounce window.
  a.proc.emit(ev.turn(), ev.text("done with it"), ev.end());
  await a.rt.settled();
  const [update] = await rowsTo(t, lead.id, "member_update");
  expect(update).toMatchObject({ fromAgentId: a.id, state: "pending" });

  await t.app.terminator.terminate(a.id, await seedTestUser(t.db, "or"));
  expect(await stateOf(t, peerRow?.id ?? "")).toBe("rejected");
  expect(await stateOf(t, direct.id)).toBe("rejected");
  expect(await stateOf(t, update?.id ?? "")).toBe("pending");
  // The late hand-off of the direct message finds the committed latch.
  await expect(t.app.runtimes.deliver(direct, "human")).rejects.toBeInstanceOf(
    AgentTerminatedError,
  );
  // A new send is refused by the Router.
  expect(
    (await t.app.router.send({ userId: user.id, handle: user.handle }, [a.slug], "hello?", false))
      .results,
  ).toMatchObject([{ status: "refused", code: "terminated" }]);
});

test("a forward that started before the commit and finishes after it writes nothing", async () => {
  const { t, driver, lead } = await setup();
  const child = await spawnIdle(t, driver, lead, "fw");
  const before = await rowsTo(t, lead.id, "member_update");
  const hold = holdTermination(t);
  const terminating = t.app.terminator.terminate(child.id, await seedTestUser(t.db, "or"));
  await hold.entered;
  const forwarding = t.app.router.forward({ agentId: child.id, body: "a late report" });
  await lockWaiter(t); // the forward waits on the child's row lock the termination holds
  hold.release();
  await terminating;
  await forwarding;
  expect(await rowsTo(t, lead.id, "member_update")).toEqual(before);
});

test("a send racing the termination is accepted, then its row is rejected and never written", async () => {
  const { t, driver, lead } = await setup();
  const { user } = await t.signUpUser();
  const child = await spawnIdle(t, driver, lead, "sr");
  const hold = holdTermination(t);
  const terminating = t.app.terminator.terminate(child.id, await seedTestUser(t.db, "or"));
  await hold.entered;
  // The Router reads the child live (the commit hasn't happened); its row commits after terminateRows ran and is
  // handed to the provisional latch, which queues it without writing.
  const {
    results: [r],
  } = await t.app.router.send(
    { userId: user.id, handle: user.handle },
    [child.slug],
    "still there?",
    false,
  );
  if (!r || r.status === "refused") throw new Error("the send was refused");
  hold.release();
  await terminating;
  expect(await stateOf(t, r.id)).toBe("rejected");
  await child.rt.settled();
  expect(child.proc.sent.flat().map((m) => m.body)).not.toContain("still there?");
});

test("rows handed over during the provisional window are rejected once it commits, held ones too", async () => {
  const { t, driver, lead } = await setup();
  const { user } = await t.signUpUser();
  const child = await spawnIdle(t, driver, lead, "pw");
  const ids: string[] = [];
  holdTermination(t, async () => {
    // Committed outside the termination's transaction after its reject-pending update ran, then handed over.
    const direct = await t.app.store.createMessage({
      from: { userId: user.id },
      toAgentId: child.id,
      recipients: ["@test"],
      body: "late",
      urgent: false,
    });
    const held = await t.app.store.createOrgRow({
      kind: "member_update",
      toAgentId: child.id,
      fromAgentId: lead.id,
      body: "an update",
    });
    ids.push(direct.id, held.id);
    await child.rt.deliver(direct, { sender: "human", fromLabel: `@${user.handle}` });
    await child.rt.receive(held);
  }).release();
  await t.app.terminator.terminate(child.id, await seedTestUser(t.db, "or"));
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(await stateOf(t, id)).toBe("rejected");
});

test("a failed transaction undoes the provisional latch: what arrived meanwhile is delivered", async () => {
  const { t, driver, lead } = await setup();
  const { user } = await t.signUpUser();
  const child = await spawnIdle(t, driver, lead, "fx");
  const row = await t.app.store.createMessage({
    from: { userId: user.id },
    toAgentId: child.id,
    recipients: ["@test"],
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
  await expect(
    t.app.terminator.terminate(child.id, await seedTestUser(t.db, "or")),
  ).rejects.toThrow("the database went away");
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

test("a termination during app.close(): no factory-restarted notice for it, and the reopened app adds nothing", async () => {
  const { t, driver, lead } = await setup();
  const child = await spawnIdle(t, driver, lead, "sd");
  // Mid-turn with live background work: a plain shutdown would leave it a factory-restarted notice.
  child.proc.emit(ev.turn(), ev.background([{ taskId: "t1", description: "build" }]));
  await child.rt.settled();
  const hold = holdTermination(t);
  const terminating = t.app.terminator.terminate(child.id, await seedTestUser(t.db, "or"));
  await hold.entered;
  // Shutdown inside the provisional window: its hibernate("shutdown") wins the stop, and the exit takes the terminate
  // path (the latch, not the recorded intent, chooses it). The exit's writes to the child's row wait for the commit.
  const closing = t.app.close();
  await lockWaiter(t, "update");
  expect(child.proc.stopped).toBe(true);
  hold.release();
  await terminating;
  await closing;
  await child.rt.settled();
  const notices = () =>
    t.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.toAgentId, child.id),
          eq(schema.messages.notice, "factory_restarted"),
        ),
      );
  expect(await notices()).toEqual([]);
  const terminatedEvents = async () =>
    (await t.app.store.after(child.id, 0, 1000)).filter((e) => e.event.type === "terminated");
  expect(await terminatedEvents()).toHaveLength(1);
  const lost = (await t.app.store.after(child.id, 0, 1000)).map((e) => e.event);
  expect(lost).toContainEqual(
    expect.objectContaining({ type: "background_work_lost", reason: "terminated" }),
  );
  expect(lost).not.toContainEqual(expect.objectContaining({ type: "hibernated" }));

  // The next boot neither wakes nor notifies it, and records nothing twice.
  const startsBefore = driver.starts.filter((p) => p.spec.agentId === child.id).length;
  const next = await t.reopen();
  expect(driver.starts.filter((p) => p.spec.agentId === child.id)).toHaveLength(startsBefore);
  expect(await notices()).toEqual([]);
  const after = (await next.app.store.after(child.id, 0, 1000)).map((e) => e.event.type);
  expect(after.filter((type) => type === "terminated")).toHaveLength(1);
  expect(after).not.toContain("reconciled");
});

/** An open hold between two agents. */
async function openHold(app: T, p: string, q: string) {
  const [x, y] = p < q ? [p, q] : [q, p];
  const holdId = randomUUID();
  await app.db
    .insert(schema.loopHolds)
    .values({ id: holdId, agentA: x, agentB: y, openedAt: new Date() });
  return holdId;
}
/** A `loop_held` row of a hold, parked and never handed over. */
const heldRow = (app: T, loopHoldId: string, fromId: string, toId: string, body: string) =>
  app.app.store.createMessage({
    from: { agentId: fromId },
    toAgentId: toId,
    recipients: ["@x"],
    body,
    urgent: false,
    state: "loop_held",
    loopHoldId,
  });

test("terminating an agent rejects its loop-held rows; archiving leaves them held", async () => {
  const { t, driver, lead, pm } = await setup();
  const a = await spawnIdle(t, driver, lead, "la");
  const b = pm;
  const hold = await openHold(t, a.id, b.id);
  const toA = await heldRow(t, hold, b.id, a.id, "held to a");
  const toB = await heldRow(t, hold, a.id, b.id, "held to b");
  expect(await t.app.store.pendingQueue(a.id)).not.toContainEqual(
    expect.objectContaining({ id: toA.id }),
  );
  await t.app.agents.archive(b.slug, { kind: "human", handle: "or" });
  expect(await stateOf(t, toB.id)).toBe("loop_held");
  await t.app.terminator.terminate(a.id, await seedTestUser(t.db, "or"));
  expect(await stateOf(t, toA.id)).toBe("rejected");
  expect(await stateOf(t, toB.id)).toBe("loop_held");
});

test("boot rejects loop-held rows to terminated agents and leaves the others", async () => {
  const { t, driver, lead } = await setup();
  const a = await spawnIdle(t, driver, lead, "ba");
  const b = await spawnIdle(t, driver, lead, "bb");
  const hold = await openHold(t, a.id, b.id);
  const toA = await heldRow(t, hold, b.id, a.id, "to a");
  const toB = await heldRow(t, hold, a.id, b.id, "to b");
  // The crash window: terminated without the transaction having rejected what raced in.
  await t.db
    .update(schema.agents)
    .set({ terminatedAt: new Date(), terminatedBy: (await seedTestUser(t.db, "or")).id })
    .where(eq(schema.agents.id, a.id));
  await t.app.store.rejectPendingToTerminated();
  expect(await stateOf(t, toA.id)).toBe("rejected");
  expect(await stateOf(t, toB.id)).toBe("loop_held");
});

test("terminate_agent by its tag terminates silently; by a plain handle it warns", async () => {
  const { t, driver, lead } = await setup();
  const url = `http://127.0.0.1:${t.app.agentListener.port}`;
  const token = t.app.agentTokens.mint(lead.id).token;
  const a = await spawnIdle(t, driver, lead, "w1");
  const b = await spawnIdle(t, driver, lead, "w2");
  const [aRef] = await t.sql`select ref from principals where handle = ${a.slug}`;
  const [bRef] = await t.sql`select ref from principals where handle = ${b.slug}`;
  const tagged = await callTool(url, token, "terminate_agent", { target: `<@${aRef?.ref}|stale>` });
  expect(tagged.isError).toBeFalsy();
  expect(JSON.parse(tagged.content[0]?.text ?? "")).toEqual({ slug: a.slug, status: "terminated" });
  const plain = await callTool(url, token, "terminate_agent", { target: b.slug });
  expect(JSON.parse(plain.content[0]?.text ?? "").warnings).toEqual([
    `Plain tag detected: @${b.slug} was resolved to <@${bRef?.ref}|${b.slug}>. Tag as <@ref|handle>.`,
  ]);
});
