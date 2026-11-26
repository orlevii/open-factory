import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { tagOf } from "@open-factory/shared/tags";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { type AgentRecord, principalsByHandles } from "../principals/principal-store.ts";
import { agentRowOf, makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal, testRef } from "../test/principals.ts";
import { asRunning } from "../test/running.ts";
import { SpawnService } from "./spawn-service.ts";

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An app with projects app/web/docs, secrets GH_TOKEN/NPM_TOKEN, a spawner `lead` (grants app, web; secret GH_TOKEN). */
async function setup() {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver });
  const app = t;
  const ids: Record<string, string> = {};
  for (const name of ["app", "web", "docs"]) {
    ids[name] = randomUUID();
    await app.db.insert(schema.projects).values({
      id: ids[name],
      name,
      hostPath: mkdtempSync(path.join(tmpdir(), `of-${name}-`)),
    });
  }
  for (const name of ["GH_TOKEN", "NPM_TOKEN"]) {
    const id = randomUUID();
    await app.db
      .insert(schema.secrets)
      .values({ id, name, valueEnc: app.app.vault.seal("v", `secrets:${id}`) });
  }
  writeTemplate(
    app.factoryHome,
    "tech-lead",
    "name: tech-lead\ndisplay_name: Tech Lead\nruntime: local\nprojects:\n  - app\n  - docs\nsecrets:\n  - GH_TOKEN\n  - NPM_TOKEN\n",
  );
  writeTemplate(app.factoryHome, "dev", "name: dev\ndisplay_name: Dev\nruntime: local\n");
  const lead = await app.seedAgent({
    handle: "lead",
    config: {
      template: {
        can_spawn: ["tech-lead", "dev"],
        secrets: ["GH_TOKEN"],
      },
    },
  });
  // I2 §6.2: spawning follows what the spawner's running process started with.
  await asRunning(app.app, lead);
  await app.db.insert(schema.agentProjectGrants).values([
    { agentId: lead.id, projectId: ids.app as string },
    { agentId: lead.id, projectId: ids.web as string },
  ]);
  const pm = await app.seedAgent({ handle: "pm" });
  await app.db.update(schema.agents).set({ reportsTo: lead.id }).where(eq(schema.agents.id, pm.id));
  return { t: app, driver, lead, pm };
}

const args = (o: Partial<{ template: string; suffix: string }> = {}) => ({
  template: "tech-lead",
  description: "Plans the work",
  prompt: "Write a plan",
  ...o,
});

async function grantNames(app: T, agentId: string) {
  const rows = await app.db
    .select({ name: schema.projects.name })
    .from(schema.agentProjectGrants)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
    .where(eq(schema.agentProjectGrants.agentId, agentId));
  return rows.map((r) => r.name).sort();
}
async function events(app: T, agentId: string) {
  const rows = await app.db
    .select()
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.agentId, agentId))
    .orderBy(asc(schema.sessionEvents.seq));
  return rows.map((r) => ({ seq: r.seq, event: { ...(r.payload as object), type: r.type } }));
}
async function peerRowsTo(app: T, agentId: string) {
  return app.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.toId, agentId), eq(schema.messages.kind, "peer_joined")));
}
async function messagesTo(app: T, agentId: string) {
  return app.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.toId, agentId), eq(schema.messages.kind, "message")));
}
const folders = (app: T) => readdirSync(path.join(app.factoryHome, "agents")).sort();
const agentCount = async (app: T) => (await app.db.select().from(schema.agents)).length;

/** A spawned child row inserted directly (no folder): seeds children to show a spawn isn't refused for them. */
async function seedChild(
  app: T,
  lead: AgentRecord,
  handle: string,
  o: { terminated?: boolean } = {},
) {
  const principal = await seedTestPrincipal(app.db, "agent", handle);
  await app.db.insert(schema.agents).values({
    id: principal.id,
    displayName: handle,
    template: "dev",
    config: {},
    runtime: "local",
    kind: "ephemeral",
    reportsTo: lead.id,
    credentialId: lead.credentialId,
    ...(o.terminated ? { terminatedAt: new Date() } : {}),
  });
}

test("spawn: child row, all the spawner's grants, brief, spawned event, peer rows (spawner excluded), note", async () => {
  const { t, lead, pm } = await setup();
  const r = await t.app.spawner.spawn(lead.id, args({ suffix: "x1" }), "toolu_1");
  expect(r).toMatchObject({
    ok: true,
    handle: "tech-lead-x1",
    status: "hibernated",
    note: "Not passed on, because you don't hold them: secrets NPM_TOKEN; projects docs.",
  });
  const child = await agentRowOf(t.app, "tech-lead-x1");
  expect(r.ok && r.agentId).toBe(child?.id);
  expect(child).toMatchObject({
    kind: "ephemeral",
    reportsTo: lead.id,
    credentialId: lead.credentialId,
    displayName: "Tech Lead · x1",
    description: "Plans the work",
    template: "tech-lead",
    runtime: "local",
  });
  if (!child) throw new Error("no child");
  // Every project the spawner holds, including web, which the child's template doesn't list.
  expect(await grantNames(t, child.id)).toEqual(["app", "web"]);
  // The brief is a message from the spawner (it may already be delivered: the hand-off is not awaited).
  expect(await messagesTo(t, child.id)).toEqual([
    expect.objectContaining({
      fromId: lead.id,
      body: "Write a plan",
      fromToolUseId: "toolu_1",
    }),
  ]);
  expect((await events(t, child.id))[0]).toMatchObject({
    seq: 1,
    event: { type: "spawned", by: tagOf(testRef(lead.id)), template: "tech-lead" },
  });
  expect(await peerRowsTo(t, pm.id)).toEqual([
    expect.objectContaining({ kind: "peer_joined", subjectAgentId: child.id, notice: "peer" }),
  ]);
  expect(await peerRowsTo(t, lead.id)).toEqual([]);
  const ref = await t.app.store.refOfAgent(child.id);
  expect(existsSync(path.join(t.factoryHome, "agents", ref, "AGENTS.md"))).toBe(true);
});

test("a random suffix is 4 letters and the display name carries it", async () => {
  const { t, lead } = await setup();
  const r = await t.app.spawner.spawn(lead.id, args({ template: "dev" }), null);
  if (!r.ok) throw new Error(r.message);
  expect(r.handle).toMatch(/^dev-[a-z]{4}$/);
  expect(r.note).toBeUndefined();
  const child = await agentRowOf(t.app, r.handle);
  expect(child?.displayName).toBe(`Dev · ${r.handle.slice(4)}`);
});

test("refusals spend nothing: template not allowed, taken explicit suffix, inheritance, shutdown", async () => {
  const { t, lead } = await setup();
  writeTemplate(t.factoryHome, "other", "name: other\ndisplay_name: Other\nruntime: local\n");
  await t.seedAgent({ handle: "tech-lead-taken" });
  const solo = await t.seedAgent({ handle: "solo" });
  const before = { folders: folders(t), agents: await agentCount(t) };
  const unchanged = async () => {
    expect(folders(t)).toEqual(before.folders);
    expect(await agentCount(t)).toBe(before.agents);
  };
  const spawn = (a: Parameters<typeof args>[0], id = lead.id) =>
    t.app.spawner.spawn(id, args(a), null);

  expect(await spawn({ template: "other" })).toEqual({
    ok: false,
    message: "You can't spawn template other.",
  });
  await unchanged();
  expect(await spawn({ suffix: "taken" })).toEqual({
    ok: false,
    message: "@tech-lead-taken is taken; pick another suffix or leave it out.",
  });
  await unchanged();
  expect(await spawn({ suffix: "bad-" })).toEqual({
    ok: false,
    message: "A suffix can't end with a hyphen.",
  });
  expect(await t.app.spawner.spawn(lead.id, { ...args(), description: "  " }, null)).toEqual({
    ok: false,
    message: "Give a description of 1 to 500 characters.",
  });
  expect(await t.app.spawner.spawn(lead.id, { ...args(), prompt: " " }, null)).toEqual({
    ok: false,
    message: "Message is empty",
  });
  // A persistent agent with no running process (I2 §6.2), without can_spawn, and an unknown caller.
  expect(await spawn({}, solo.id)).toEqual({ ok: false, message: "@solo isn't running." });
  await asRunning(t.app, solo);
  expect(await spawn({}, solo.id)).toEqual({ ok: false, message: "You can't spawn agents." });
  expect(await spawn({}, randomUUID())).toEqual({ ok: false, message: "You can't spawn agents." });
  await unchanged();

  // Inheritance: a local child from a docker spawner.
  await t.db.update(schema.agents).set({ runtime: "docker" }).where(eq(schema.agents.id, lead.id));
  expect(await spawn({})).toEqual({
    ok: false,
    message:
      "Template tech-lead runs locally, outside the sandbox you run in, so you can't spawn it.",
  });
  await t.db.update(schema.agents).set({ runtime: "local" }).where(eq(schema.agents.id, lead.id));
  await unchanged();

  // Shutdown.
  const closing = new SpawnService({ ...serviceDeps(t), closing: () => true });
  const n = { folders: folders(t), agents: await agentCount(t) };
  expect(await closing.spawn(lead.id, args({ suffix: "late" }), null)).toEqual({
    ok: false,
    message: "The factory is shutting down; spawn again after it restarts.",
  });
  expect(folders(t)).toEqual(n.folders);
  expect(await agentCount(t)).toBe(n.agents);
});

test("a spawner is never refused for its live children: a spawn past five live children succeeds", async () => {
  const { t, lead } = await setup();
  for (const handle of ["dev-a", "dev-b", "dev-c", "dev-d", "dev-e", "dev-f"])
    await seedChild(t, lead, handle);
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "more" }), null)).toMatchObject({
    ok: true,
    handle: "tech-lead-more",
  });
});

test("a spawner is never refused for how many it spawned in an hour: a twenty-second spawn succeeds", async () => {
  const { t, lead } = await setup();
  for (let i = 0; i < 21; i++) await seedChild(t, lead, `dev-h${i}`, { terminated: true });
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "more" }), null)).toMatchObject({
    ok: true,
    handle: "tech-lead-more",
  });
});

test("an ephemeral caller can't spawn, whatever its template says", async () => {
  const { t, lead } = await setup();
  writeTemplate(
    t.factoryHome,
    "sub-lead",
    "name: sub-lead\ndisplay_name: Sub Lead\nruntime: local\ncan_spawn:\n  - dev\n",
  );
  await t.db
    .update(schema.agents)
    .set({ config: { template: { can_spawn: ["sub-lead"] } } })
    .where(eq(schema.agents.id, lead.id));
  await asRunning(t.app, lead);
  const r = await t.app.spawner.spawn(lead.id, args({ template: "sub-lead", suffix: "s" }), null);
  if (!r.ok) throw new Error(r.message);
  const child = await t.app.store.agentById(r.agentId);
  if (!child) throw new Error("no child");
  // Even running, on a template with can_spawn.
  await asRunning(t.app, child);
  expect(await t.app.spawner.spawn(r.agentId, args({ template: "dev" }), null)).toEqual({
    ok: false,
    message: "You can't spawn agents.",
  });
});

/** Gates `workspace.materialize`: each call materializes for real, then waits for `gate`. */
function gateMaterialize(app: T) {
  const gate = deferred();
  const started: string[] = [];
  const entered = deferred();
  const real = app.app.workspace.materialize.bind(app.app.workspace);
  let want = 1;
  vi.spyOn(app.app.workspace, "materialize").mockImplementation(async (...a) => {
    await real(...a);
    started.push(a[2].handle);
    if (started.length >= want) entered.resolve();
    await gate.promise;
  });
  return {
    gate,
    started,
    /** Resolves once `n` materializes are in flight. */
    waitFor(n: number) {
      want = n;
      if (started.length >= n) entered.resolve();
      return entered.promise;
    },
  };
}

test("a spawn racing an archive of its spawner: the archive refuses or the spawn refuses, never an archived spawner with a live child", async () => {
  const { t, lead, pm } = await setup();
  await t.db
    .update(schema.agents)
    .set({ reportsTo: lead.reportsTo })
    .where(eq(schema.agents.id, pm.id));
  const g = gateMaterialize(t);
  const spawning = t.app.spawner.spawn(lead.id, args({ suffix: "race" }), null);
  await g.waitFor(1);
  // The archive commits while materialize is in flight: the spawn must refuse under its lock.
  await t.app.agents.archive(await t.refOf("lead"), {
    kind: "human",
    ref: "k7x2m9qd",
    handle: "or",
  });
  g.gate.resolve();
  expect(await spawning).toEqual({ ok: false, message: "You can't spawn agents." });
  expect(await agentRowOf(t.app, "tech-lead-race")).toBeUndefined();
  expect(folders(t)).not.toContain("tech-lead-race");

  // The other order: a committed spawn makes the archive refuse.
  vi.restoreAllMocks();
  const lead2 = await t.seedAgent({
    handle: "lead2",
    config: { template: { can_spawn: ["dev"] } },
  });
  await asRunning(t.app, lead2);
  const r = await t.app.spawner.spawn(lead2.id, args({ template: "dev", suffix: "k" }), null);
  expect(r.ok).toBe(true);
  await expect(
    t.app.agents.archive(await t.refOf("lead2"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({
    status: 409,
    code: "has_reports",
  });
  expect((await agentRowOf(t.app, "lead2"))?.archivedAt).toBeNull();
});

test("a spawn racing a credential change: the child ends with the spawner's post-change credential", async () => {
  const { t, lead } = await setup();
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "second",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok-2", `credentials:${credId}`),
  });
  const g = gateMaterialize(t);
  const spawning = t.app.spawner.spawn(lead.id, args({ suffix: "cred" }), null);
  await g.waitFor(1);
  await t.app.agents.update(
    await t.refOf("lead"),
    { credential: "second" },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  g.gate.resolve();
  expect(await spawning).toMatchObject({ ok: true });
  expect((await agentRowOf(t.app, "tech-lead-cred"))?.credentialId).toBe(credId);
});

test("a spawn racing a grant change: the child gets the spawner's post-change grants", async () => {
  const { t, lead } = await setup();
  const g = gateMaterialize(t);
  const spawning = t.app.spawner.spawn(lead.id, args({ suffix: "gr" }), null);
  await g.waitFor(1);
  await t.app.agents.update(
    await t.refOf("lead"),
    { projects: ["web"] },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  g.gate.resolve();
  const r = await spawning;
  expect(r).toMatchObject({
    ok: true,
    note: "Not passed on, because you don't hold them: secrets NPM_TOKEN; projects app, docs.",
  });
  const child = await agentRowOf(t.app, "tech-lead-gr");
  expect(await grantNames(t, child?.id ?? "")).toEqual(["web"]);
});

test("five taken names in a row: the spawn gives up and asks for a suffix", async () => {
  const { t, lead } = await setup();
  await seedTestPrincipal(t.db, "human", "tech-lead-aaaa");
  const stuck = new SpawnService({ ...serviceDeps(t), random: () => "aaaa" });
  expect(await stuck.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "Couldn't find a free name for tech-lead-xxxx; pass a suffix.",
  });
});

test("a taken suffix retries the next name: a human holds one at the pre-read, another lands after it", async () => {
  const { t, lead } = await setup();
  // A human's handle holds the first name: the pre-read skips it.
  await seedTestPrincipal(t.db, "human", "tech-lead-aaaa");
  // A human's handle lands after the pre-read (during materialize): the principal insert in the transaction refuses it.
  const realMaterialize = t.app.workspace.materialize.bind(t.app.workspace);
  vi.spyOn(t.app.workspace, "materialize").mockImplementation(async (...a) => {
    if (a[2].handle === "tech-lead-bbbb") await seedTestPrincipal(t.db, "human", "tech-lead-bbbb");
    return realMaterialize(...a);
  });
  const before = folders(t);
  const suffixes = ["aaaa", "bbbb", "dddd"];
  const svc = new SpawnService({ ...serviceDeps(t), random: () => suffixes.shift() ?? "zzzz" });
  expect(await svc.spawn(lead.id, args(), null)).toMatchObject({
    ok: true,
    handle: "tech-lead-dddd",
  });
  // Only the winner's folder was added: the one made for the refused name was removed.
  expect(folders(t)).toHaveLength(before.length + 1);
  const holder = (await principalsByHandles(t.db, ["tech-lead-dddd"])).get("tech-lead-dddd");
  expect(holder?.kind).toBe("agent");
});

test("an explicit suffix taken by a human's handle after the pre-read is reported taken", async () => {
  const { t, lead } = await setup();
  const before = folders(t);
  const realMaterialize = t.app.workspace.materialize.bind(t.app.workspace);
  vi.spyOn(t.app.workspace, "materialize").mockImplementation(async (...a) => {
    await seedTestPrincipal(t.db, "human", "tech-lead-mine");
    return realMaterialize(...a);
  });
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "mine" }), null)).toEqual({
    ok: false,
    message: "@tech-lead-mine is taken; pick another suffix or leave it out.",
  });
  expect(folders(t)).toEqual(before);
});

test("an agent that takes the name after the pre-read is reported taken; its workspace stays and the loser's folder goes", async () => {
  const { t, lead } = await setup();
  let winner: AgentRecord | undefined;
  const before = folders(t);
  const realMaterialize = t.app.workspace.materialize.bind(t.app.workspace);
  vi.spyOn(t.app.workspace, "materialize").mockImplementation(async (...a) => {
    const made = await realMaterialize(...a);
    // The winner commits its agent (and writes its workspace) before the loser's transaction.
    winner = await t.seedAgent({ handle: "tech-lead-mine" });
    return made;
  });
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "mine" }), null)).toEqual({
    ok: false,
    message: "@tech-lead-mine is taken; pick another suffix or leave it out.",
  });
  expect(folders(t)).toEqual([...before, await t.app.store.refOfAgent(winner?.id ?? "")].sort());
});

test("a refusal under the lock leaves no principal behind", async () => {
  const { t, lead } = await setup();
  // The pre-check passes; the re-check in the transaction refuses (the credential changed during materialize).
  const svc = new SpawnService(serviceDeps(t));
  const real = (svc as unknown as { check: (...a: unknown[]) => Promise<unknown> }).check.bind(svc);
  let calls = 0;
  vi.spyOn(svc as unknown as { check: () => Promise<unknown> }, "check").mockImplementation(
    async (...a: unknown[]) =>
      ++calls === 1 ? real(...a) : { ok: false, message: "refused under the lock" },
  );
  expect(await svc.spawn(lead.id, args({ suffix: "orph" }), null)).toEqual({
    ok: false,
    message: "refused under the lock",
  });
  expect(calls).toBe(2);
  expect((await principalsByHandles(t.db, ["tech-lead-orph"])).size).toBe(0);
});

test("a template that is missing or invalid on disk is refused before anything is made", async () => {
  const { t, lead } = await setup();
  writeTemplate(t.factoryHome, "dev", "name: dev\nruntime: nonsense\n");
  const before = folders(t);
  expect(await t.app.spawner.spawn(lead.id, args({ template: "dev" }), null)).toEqual({
    ok: false,
    message: "Template dev is missing or invalid; ask your manager to fix it.",
  });
  expect(folders(t)).toEqual(before);
});

test("I2 §6.2: a spawner whose current config can't be read refuses before anything is made", async () => {
  const { t, lead } = await setup();
  await t.sql`update agents set config = '{"bogus":1}'::jsonb where id = ${lead.id}`;
  const before = folders(t);
  expect(await t.app.spawner.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "Your configuration can't be read; ask your manager to fix it.",
  });
  expect(folders(t)).toEqual(before);
});

test("I2 §6.2: the allowlist is started's; secrets are the stricter of started and current", async () => {
  const { t, lead } = await setup();
  // The current overlay drops tech-lead and GH_TOKEN; the running process still started with both.
  await t.sql`update agents set config = '{"template":{"can_spawn":["dev"]}}'::jsonb where id = ${lead.id}`;
  const r = await t.app.spawner.spawn(lead.id, args({ suffix: "s1" }), null);
  if (!r.ok) throw new Error(r.message);
  // tech-lead lists GH_TOKEN and NPM_TOKEN; the spawner now holds neither (current ∩ started).
  expect(r.note).toBe(
    "Not passed on, because you don't hold them: secrets GH_TOKEN, NPM_TOKEN; projects docs.",
  );
  // Once the process restarts on the new config, tech-lead is no longer allowed.
  await asRunning(t.app, lead);
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "s2" }), null)).toEqual({
    ok: false,
    message: "You can't spawn template tech-lead.",
  });
});

test("a caller with a manager is told to ask its manager", async () => {
  const { t, lead } = await setup();
  const boss = await t.seedAgent({ handle: "boss" });
  await t.sql`update agents set reports_to = ${boss.id} where id = ${lead.id}`;
  writeTemplate(t.factoryHome, "dev", "name: dev\nruntime: nonsense\n");
  expect(await t.app.spawner.spawn(lead.id, args({ template: "dev" }), null)).toEqual({
    ok: false,
    message: "Template dev is missing or invalid; ask your manager to fix it.",
  });
  await t.sql`update agents set config = '{"bogus":1}'::jsonb where id = ${lead.id}`;
  expect(await t.app.spawner.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "Your configuration can't be read; ask your manager to fix it.",
  });
});

function serviceDeps(app: T): ConstructorParameters<typeof SpawnService>[0] {
  return {
    db: app.db,
    store: app.app.store,
    templates: app.app.templates,
    workspace: app.app.workspace,
    router: app.app.router,
    runtimes: app.app.runtimes,
    resolver: app.app.resolver,
    config: app.app.config,
    log: app.app.log,
    closing: () => false,
  };
}
