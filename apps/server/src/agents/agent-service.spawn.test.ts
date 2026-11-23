import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { asRunning } from "../test/running.ts";
import { ev, FakeDriver, type FakeProcess } from "./testing/fake-driver.ts";
import { sendAs } from "./testing/runtime-harness.ts";

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
const leadYaml = (projects: string[]) =>
  `name: lead\ndisplay_name: Lead\nruntime: local\ncan_spawn:\n  - dev\nprojects:\n${projects.map((p) => `  - ${p}\n`).join("")}`;

/**
 * `lead` (created from its template: credential `work`, projects app and docs, may spawn `dev`, which asks for both).
 * A second credential `spare` exists.
 */
async function setup() {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver });
  const app = t;
  const project = async (name: string) => {
    const id = randomUUID();
    await app.db
      .insert(schema.projects)
      .values({ id, name, hostPath: mkdtempSync(path.join(tmpdir(), `of-${name}-`)) });
    return id;
  };
  const projects = { app: await project("app"), docs: await project("docs") };
  const cred = async (name: string) => {
    const id = randomUUID();
    await app.db.insert(schema.credentials).values({
      id,
      name,
      kind: "oauth_token",
      valueEnc: app.app.vault.seal(`${name}-token`, `credentials:${id}`),
    });
    return id;
  };
  const creds = { work: await cred("work"), spare: await cred("spare") };
  writeTemplate(app.factoryHome, "lead", leadYaml(["app", "docs"]));
  writeTemplate(
    app.factoryHome,
    "dev",
    "name: dev\ndisplay_name: Dev\nruntime: local\nprojects:\n  - app\n  - docs\n",
  );
  await app.app.agents.create({
    template: "lead",
    slug: "lead",
    displayName: "Lead",
    description: "",
    reportsTo: null,
    credential: "work",
  });
  const lead = await row(app, "lead");
  // I2 §6.2: spawning follows the spawner's running process.
  await asRunning(app.app, lead);
  return { t: app, driver, lead, projects, creds };
}

async function row(app: T, slug: string) {
  const [r] = await app.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r;
}
const grantIds = async (app: T, agentId: string) =>
  (
    await app.db
      .select({ id: schema.agentProjectGrants.projectId })
      .from(schema.agentProjectGrants)
      .where(eq(schema.agentProjectGrants.agentId, agentId))
  )
    .map((r) => r.id)
    .sort();

/** Spawns `dev-<suffix>` from lead, lets its brief start it, and ends its first turn: a started, idle child. */
async function spawnIdle(app: T, driver: FakeDriver, spawnerId: string, suffix: string) {
  const r = await app.app.spawner.spawn(
    spawnerId,
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

test("a spawner's credential change rewrites its live children in the same transaction, restarts them, and moves their pause lookup", async () => {
  const { t, driver, lead, creds } = await setup();
  const child = await spawnIdle(t, driver, lead.id, "c1");
  expect((await row(t, child.slug)).credentialId).toBe(creds.work);

  await t.app.agents.update("lead", { credential: "spare" });
  expect((await row(t, "lead")).credentialId).toBe(creds.spare);
  expect((await row(t, child.slug)).credentialId).toBe(creds.spare);
  // The idle child got the restart: its process was stopped to apply the change.
  await child.rt.settled();
  expect(child.proc.stopped).toBe(true);
  expect(child.rt.live().status).toBe("hibernated");

  // The Supervisor reads the loaded runtime's credential: pausing the new one holds the child's next wake.
  t.app.runtimes.supervisor.pause(creds.spare, new Date(Date.now() + 3_600_000), true);
  const u = await t.signUpUser();
  await sendAs(t.app.store, child.rt, {
    fromUserId: u.user.id,
    fromHandle: u.user.handle,
    body: "hi",
    urgent: false,
  });
  await child.rt.settled();
  expect(t.app.runtimes.supervisor.isQueued(child.id)).toBe(true);
  expect(child.rt.live().status).toBe("rate_limited");
  expect(driver.starts.filter((p) => p.spec.agentId === child.id)).toHaveLength(1);
});

test("revoking one of the spawner's grants removes it from its children, and a running child restarts", async () => {
  const { t, driver, lead, projects } = await setup();
  const child = await spawnIdle(t, driver, lead.id, "g1");
  expect(await grantIds(t, child.id)).toEqual([projects.app, projects.docs].sort());

  await t.app.agents.update("lead", { projects: ["app"] });
  expect(await grantIds(t, child.id)).toEqual([projects.app]);
  await child.rt.settled();
  expect(child.proc.stopped).toBe(true);

  // Granting it back to the spawner gives it back to the child (spawner's grants ∩ the child's template).
  await t.app.agents.update("lead", { projects: null });
  expect(await grantIds(t, child.id)).toEqual([projects.app, projects.docs].sort());
});

test("a spawner re-sync whose template drops a project removes it from its children", async () => {
  const { t, driver, lead, projects } = await setup();
  const child = await spawnIdle(t, driver, lead.id, "r1");
  writeTemplate(t.factoryHome, "lead", leadYaml(["docs"]));
  const restarts = vi.spyOn(t.app.runtimes, "requestRestart");
  const refreshes = vi.spyOn(t.app.runtimes, "refresh");

  await t.app.agents.resync("lead");
  expect(await grantIds(t, lead.id)).toEqual([projects.docs]);
  expect(await grantIds(t, child.id)).toEqual([projects.docs]);
  expect(refreshes.mock.calls.map((c) => c[0])).toContain(child.id);
  expect(restarts.mock.calls.map((c) => c[0])).toContain(child.id);
});

test("a spawner re-sync refreshes and restarts every live child, even when its grants are unchanged", async () => {
  const { t, driver, lead } = await setup();
  const child = await spawnIdle(t, driver, lead.id, "r2");
  const gone = await spawnIdle(t, driver, lead.id, "r3");
  expect(await t.app.terminator.terminate(gone.id, "@or")).toEqual({ status: "terminated" });
  await gone.rt.settled();
  const restarts = vi.spyOn(t.app.runtimes, "requestRestart");
  const refreshes = vi.spyOn(t.app.runtimes, "refresh");

  await t.app.agents.resync("lead");
  // The child's secrets and deny rules derive from the spawner at start, so it restarts to pick the change up.
  expect(refreshes.mock.calls.map((c) => c[0])).toContain(child.id);
  expect(restarts.mock.calls.map((c) => c[0])).toContain(child.id);
  expect(restarts.mock.calls.map((c) => c[0])).not.toContain(gone.id);
});

test("terminated children are never touched by syncChildren", async () => {
  const { t, driver, lead, creds, projects } = await setup();
  const live = await spawnIdle(t, driver, lead.id, "l1");
  const gone = await spawnIdle(t, driver, lead.id, "t1");
  expect(await t.app.terminator.terminate(gone.id, "@or")).toEqual({ status: "terminated" });
  await gone.rt.settled();
  const before = await row(t, gone.slug);

  const changed = await t.db.transaction(async (tx) => {
    await tx
      .update(schema.agents)
      .set({ credentialId: creds.spare })
      .where(eq(schema.agents.id, lead.id));
    return t.app.agents.syncChildren(tx, lead.id);
  });
  expect(changed).toEqual([live.id]);
  expect(await row(t, gone.slug)).toEqual(before);
  expect(await grantIds(t, gone.id)).toEqual([]);
  // Nothing to change: an in-sync child isn't reported.
  expect(await t.db.transaction((tx) => t.app.agents.syncChildren(tx, lead.id))).toEqual([]);
  expect(await grantIds(t, live.id)).toEqual([projects.app, projects.docs].sort());
});

test("a child's forward holding its own row lock doesn't deadlock with a spawner update (spawner first, NO KEY UPDATE)", async () => {
  const { t, driver, lead, creds } = await setup();
  const child = await spawnIdle(t, driver, lead.id, "f1");
  // A forward's stand-in: the child's row FOR NO KEY UPDATE, then (after the update waits on that row) a message row
  // naming the spawner, whose FK takes KEY SHARE on the spawner row the update already holds.
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let locked!: () => void;
  const childLocked = new Promise<void>((r) => {
    locked = r;
  });
  const forward = t.sql.begin(async (tx) => {
    await tx`select id from agents where id = ${child.id} for no key update`;
    locked();
    await released;
    await tx`insert into messages (id, from_agent_id, to_agent_id, body, kind, state)
             values (${randomUUID()}, ${child.id}, ${lead.id}, 'done', 'member_update', 'pending')`;
  });
  await childLocked;
  const update = t.app.agents.update("lead", { credential: "spare" });
  for (;;) {
    const [w] = await t.sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ilike '%for no key update%' and query not ilike '%pg_stat_activity%'`;
    if ((w?.n ?? 0) >= 1) break;
  }
  release();
  await forward;
  await update;
  expect((await row(t, child.slug)).credentialId).toBe(creds.spare);
});
