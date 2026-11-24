import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { claimTestHandle } from "../test/handles.ts";
import { makeTestApp } from "../test/helpers.ts";
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
async function setup(
  o: { env?: Record<string, string>; lead?: { max_live_spawns?: number } } = {},
) {
  const driver = new FakeDriver();
  t = await makeTestApp({ harnessDriver: driver, ...(o.env ? { env: o.env } : {}) });
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
    slug: "lead",
    config: {
      template: {
        can_spawn: ["tech-lead", "dev"],
        max_live_spawns: 5,
        secrets: ["GH_TOKEN"],
        ...o.lead,
      },
    },
  });
  // I2 §6.2: spawning follows what the spawner's running process started with.
  await asRunning(app.app, lead);
  await app.db.insert(schema.agentProjectGrants).values([
    { agentId: lead.id, projectId: ids.app as string },
    { agentId: lead.id, projectId: ids.web as string },
  ]);
  const pm = await app.seedAgent({ slug: "pm" });
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
    .where(and(eq(schema.messages.toAgentId, agentId), eq(schema.messages.kind, "peer_joined")));
}
async function messagesTo(app: T, agentId: string) {
  return app.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.toAgentId, agentId), eq(schema.messages.kind, "message")));
}
const folders = (app: T) => readdirSync(path.join(app.factoryHome, "agents")).sort();
const agentCount = async (app: T) => (await app.db.select().from(schema.agents)).length;

/** A spawned child row inserted directly (no folder): for the live count and the rate. */
async function seedChild(app: T, lead: AgentRow, slug: string, o: { terminated?: boolean } = {}) {
  await claimTestHandle(app.db, slug, "agent");
  await app.db.insert(schema.agents).values({
    id: randomUUID(),
    slug,
    displayName: slug,
    template: "dev",
    config: {},
    runtime: "local",
    kind: "ephemeral",
    reportsTo: lead.id,
    credentialId: lead.credentialId,
    ...(o.terminated ? { terminatedAt: new Date(), terminatedBy: "@or" } : {}),
  });
}

test("spawn: child row, grants ∩, brief, spawned event, peer rows (spawner excluded), note", async () => {
  const { t, lead, pm } = await setup();
  const r = await t.app.spawner.spawn(lead.id, args({ suffix: "x1" }), "toolu_1");
  expect(r).toMatchObject({
    ok: true,
    slug: "tech-lead-x1",
    status: "hibernated",
    note: "Not passed on, because you don't hold them: secrets NPM_TOKEN; projects docs.",
  });
  const child = await t.app.store.agentBySlug("tech-lead-x1");
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
  expect(await grantNames(t, child.id)).toEqual(["app"]);
  // The brief is a message from the spawner (it may already be delivered: the hand-off is not awaited).
  expect(await messagesTo(t, child.id)).toEqual([
    expect.objectContaining({
      fromAgentId: lead.id,
      body: "Write a plan",
      fromToolUseId: "toolu_1",
    }),
  ]);
  expect((await events(t, child.id))[0]).toMatchObject({
    seq: 1,
    event: { type: "spawned", by: "lead", template: "tech-lead" },
  });
  expect(await peerRowsTo(t, pm.id)).toEqual([
    expect.objectContaining({ kind: "peer_joined", subjectAgentId: child.id, notice: "peer" }),
  ]);
  expect(await peerRowsTo(t, lead.id)).toEqual([]);
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-x1", "AGENTS.md"))).toBe(true);
});

// AC 10: spawn never installs; Claude Code does, at each agent's first start, into that agent's own plugins dir.
test("three spawns of a template with a plugin return without an install; each start gets its own plugins dir", async () => {
  const { t, driver, lead } = await setup();
  const mk = mkdtempSync(path.join(tmpdir(), "of-mk-"));
  mkdirSync(path.join(mk, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(mk, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "mk", plugins: [{ name: "p", source: "./plugins/p" }] }),
  );
  mkdirSync(path.join(mk, "plugins/p/.claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(mk, "plugins/p/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "p", version: "1.0.0" }),
  );
  await t.db.insert(schema.marketplaces).values({
    name: "mk",
    source: { source: "directory", path: mk },
    tags: {},
    state: "ready",
    startedAt: new Date(),
    addedBy: "@or",
    addedAt: new Date(),
  });
  writeTemplate(t.factoryHome, "plugged", "name: plugged\ndisplay_name: P\nruntime: local\n");
  writeFileSync(
    path.join(t.factoryHome, "templates/plugged/settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: { mk: { source: { source: "directory", path: mk } } },
      enabledPlugins: { "p@mk": true },
    }),
  );
  await t.db
    .update(schema.agents)
    .set({ config: { template: { can_spawn: ["plugged"], max_live_spawns: 5 } } })
    .where(eq(schema.agents.id, lead.id));
  const slugs: string[] = [];
  for (const suffix of ["a", "b", "c"]) {
    const r = await t.app.spawner.spawn(lead.id, args({ template: "plugged", suffix }), null);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) slugs.push(r.slug);
    // Spawn installed nothing: no plugins dir exists before the first start.
    expect(
      existsSync(path.join(t.factoryHome, "state/agents", slugs.at(-1) ?? "", "plugins")),
    ).toBe(false);
  }
  await vi.waitFor(() => expect(driver.starts.length).toBeGreaterThanOrEqual(3));
  const dirs = driver.starts.map((p) => p.spec.env.CLAUDE_CODE_PLUGIN_CACHE_DIR);
  expect(new Set(dirs).size).toBe(dirs.length);
  for (const slug of slugs) {
    const start = driver.starts.find((p) => p.spec.slug === slug);
    expect(start?.spec.env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toMatch(
      new RegExp(`state/agents/${slug}/plugins$`),
    );
    expect(JSON.parse(start?.spec.settingsJson ?? "{}").enabledPlugins["p@mk"]).toBe(true);
  }
});

test("a random suffix is 4 letters and the display name carries it", async () => {
  const { t, lead } = await setup();
  const r = await t.app.spawner.spawn(lead.id, args({ template: "dev" }), null);
  if (!r.ok) throw new Error(r.message);
  expect(r.slug).toMatch(/^dev-[a-z]{4}$/);
  expect(r.note).toBeUndefined();
  const child = await t.app.store.agentBySlug(r.slug);
  expect(child?.displayName).toBe(`Dev · ${r.slug.slice(4)}`);
});

test("refusals spend nothing: template not allowed, taken explicit suffix, over max_live, rate, inheritance, shutdown", async () => {
  const s = await setup({ env: { FACTORY_MAX_SPAWNS_PER_HOUR: "3" } });
  const { t, lead } = s;
  writeTemplate(t.factoryHome, "other", "name: other\ndisplay_name: Other\nruntime: local\n");
  await t.seedAgent({ slug: "tech-lead-taken" });
  const solo = await t.seedAgent({ slug: "solo" });
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

  // The rate: terminated children count.
  for (const slug of ["dev-r1", "dev-r2", "dev-r3"])
    await seedChild(t, lead, slug, { terminated: true });
  const afterRate = { folders: folders(t), agents: await agentCount(t) };
  expect(await spawn({})).toEqual({
    ok: false,
    message:
      "You've spawned 3 agents in the last hour; ask a human (list_peers lists them) if you need more.",
  });
  expect(folders(t)).toEqual(afterRate.folders);
  expect(await agentCount(t)).toBe(afterRate.agents);
  // An hour later they no longer count (injected clock).
  const later = new SpawnService({
    ...serviceDeps(t),
    now: () => Date.now() + 3_600_000 + 1000,
  });
  const ok = await later.spawn(lead.id, args({ suffix: "later" }), null);
  expect(ok).toMatchObject({ ok: true, slug: "tech-lead-later" });

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

test("over max_live_spawns: the sentence lists the live children; terminated ones don't count", async () => {
  const { t, lead } = await setup({ lead: { max_live_spawns: 2 } });
  await seedChild(t, lead, "dev-b");
  await seedChild(t, lead, "dev-a");
  await seedChild(t, lead, "dev-gone", { terminated: true });
  const before = { folders: folders(t), agents: await agentCount(t) };
  expect(await t.app.spawner.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "You have 2 live spawned agents (max 2): @dev-a, @dev-b. Terminate one first.",
  });
  expect(folders(t)).toEqual(before.folders);
  expect(await agentCount(t)).toBe(before.agents);
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
    started.push(a[1]);
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

test("two parallel spawns at max_live_spawns-1: exactly one wins and the loser's folder is removed", async () => {
  const { t, lead } = await setup({ lead: { max_live_spawns: 2 } });
  await seedChild(t, lead, "dev-old");
  const before = folders(t);
  const g = gateMaterialize(t);
  const both = Promise.all([
    t.app.spawner.spawn(lead.id, args({ suffix: "one" }), null),
    t.app.spawner.spawn(lead.id, args({ suffix: "two" }), null),
  ]);
  await g.waitFor(2);
  g.gate.resolve();
  const rs = await both;
  const won = rs.filter((r) => r.ok);
  const lost = rs.filter((r) => !r.ok);
  expect(won).toHaveLength(1);
  expect(lost).toEqual([
    {
      ok: false,
      message: expect.stringMatching(
        /^You have 2 live spawned agents \(max 2\): @dev-old, @tech-lead-(one|two)\. Terminate one first\.$/,
      ),
    },
  ]);
  const winner = won[0]?.ok ? won[0].slug : "";
  expect(folders(t)).toEqual([...before, winner].sort());
});

test("a spawn racing an archive of its spawner: the archive refuses or the spawn refuses, never an archived spawner with a live child", async () => {
  const { t, lead, pm } = await setup();
  await t.db.update(schema.agents).set({ reportsTo: null }).where(eq(schema.agents.id, pm.id));
  const g = gateMaterialize(t);
  const spawning = t.app.spawner.spawn(lead.id, args({ suffix: "race" }), null);
  await g.waitFor(1);
  // The archive commits while materialize is in flight: the spawn must refuse under its lock.
  await t.app.agents.archive("lead");
  g.gate.resolve();
  expect(await spawning).toEqual({ ok: false, message: "You can't spawn agents." });
  expect(await t.app.store.agentBySlug("tech-lead-race")).toBeUndefined();
  expect(folders(t)).not.toContain("tech-lead-race");

  // The other order: a committed spawn makes the archive refuse.
  vi.restoreAllMocks();
  const lead2 = await t.seedAgent({
    slug: "lead2",
    config: { template: { can_spawn: ["dev"], max_live_spawns: 5 } },
  });
  await asRunning(t.app, lead2);
  const r = await t.app.spawner.spawn(lead2.id, args({ template: "dev", suffix: "k" }), null);
  expect(r.ok).toBe(true);
  await expect(t.app.agents.archive("lead2")).rejects.toMatchObject({
    status: 409,
    code: "has_reports",
  });
  expect((await t.app.store.agentBySlug("lead2"))?.archivedAt).toBeNull();
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
  await t.app.agents.update("lead", { credential: "second" });
  g.gate.resolve();
  expect(await spawning).toMatchObject({ ok: true });
  expect((await t.app.store.agentBySlug("tech-lead-cred"))?.credentialId).toBe(credId);
});

test("a spawn racing a grant change: the child gets the spawner's post-change grants", async () => {
  const { t, lead } = await setup();
  const g = gateMaterialize(t);
  const spawning = t.app.spawner.spawn(lead.id, args({ suffix: "gr" }), null);
  await g.waitFor(1);
  await t.app.agents.update("lead", { projects: ["web"] });
  g.gate.resolve();
  const r = await spawning;
  expect(r).toMatchObject({
    ok: true,
    note: "Not passed on, because you don't hold them: secrets NPM_TOKEN; projects app, docs.",
  });
  const child = await t.app.store.agentBySlug("tech-lead-gr");
  expect(await grantNames(t, child?.id ?? "")).toEqual([]);
});

test("folder_exists: a random suffix retries, an explicit one is reported taken", async () => {
  const { t, lead } = await setup();
  mkdirSync(path.join(t.factoryHome, "agents", "tech-lead-aaaa"));
  mkdirSync(path.join(t.factoryHome, "agents", "tech-lead-mine"));
  const suffixes = ["aaaa", "bbbb"];
  const svc = new SpawnService({ ...serviceDeps(t), random: () => suffixes.shift() ?? "zzzz" });
  expect(await svc.spawn(lead.id, args(), null)).toMatchObject({
    ok: true,
    slug: "tech-lead-bbbb",
  });
  // The folder that isn't ours is left alone.
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-aaaa"))).toBe(true);
  expect(await svc.spawn(lead.id, args({ suffix: "mine" }), null)).toEqual({
    ok: false,
    message: "@tech-lead-mine is taken; pick another suffix or leave it out.",
  });
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-mine"))).toBe(true);
  // Five collisions in a row: give up and ask for a suffix.
  const stuck = new SpawnService({ ...serviceDeps(t), random: () => "aaaa" });
  expect(await stuck.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "Couldn't find a free name for tech-lead-xxxx; pass a suffix.",
  });
});

test("a taken suffix retries the next name: a user claim at the pre-read, a claim that lands after it", async () => {
  const { t, lead } = await setup();
  // A user's claim holds the first name: the pre-read skips it.
  await claimTestHandle(t.db, "tech-lead-aaaa", "user");
  // A user claim lands after the pre-read (during materialize): the claim in the transaction refuses it.
  const realMaterialize = t.app.workspace.materialize.bind(t.app.workspace);
  vi.spyOn(t.app.workspace, "materialize").mockImplementation(async (...a) => {
    if (a[0] === "tech-lead-bbbb") await claimTestHandle(t.db, "tech-lead-bbbb", "user");
    return realMaterialize(...a);
  });
  const suffixes = ["aaaa", "bbbb", "dddd"];
  const svc = new SpawnService({ ...serviceDeps(t), random: () => suffixes.shift() ?? "zzzz" });
  expect(await svc.spawn(lead.id, args(), null)).toMatchObject({
    ok: true,
    slug: "tech-lead-dddd",
  });
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-bbbb"))).toBe(false);
  const [claim] = await t.sql`select kind from handles where handle = 'tech-lead-dddd'`;
  expect(claim?.kind).toBe("agent");
});

test("an explicit suffix taken by a user claim after the pre-read is reported taken", async () => {
  const { t, lead } = await setup();
  const realMaterialize = t.app.workspace.materialize.bind(t.app.workspace);
  vi.spyOn(t.app.workspace, "materialize").mockImplementation(async (...a) => {
    await claimTestHandle(t.db, "tech-lead-mine", "user");
    return realMaterialize(...a);
  });
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "mine" }), null)).toEqual({
    ok: false,
    message: "@tech-lead-mine is taken; pick another suffix or leave it out.",
  });
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-mine"))).toBe(false);
});

test("losing the slug unique index to a concurrent winner reports taken and keeps the winner's workspace", async () => {
  const { t, lead } = await setup();
  vi.spyOn(t.db, "transaction").mockImplementationOnce((async () => {
    // The winner commits its agent (and its workspace) first; the loser's insert then hits the slug index.
    await t.seedAgent({ slug: "tech-lead-mine" });
    throw Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "agents_slug_unique",
    });
  }) as typeof t.db.transaction);
  expect(await t.app.spawner.spawn(lead.id, args({ suffix: "mine" }), null)).toEqual({
    ok: false,
    message: "@tech-lead-mine is taken; pick another suffix or leave it out.",
  });
  expect(existsSync(path.join(t.factoryHome, "agents", "tech-lead-mine"))).toBe(true);
});

test("a refusal under the lock leaves no handle claim behind", async () => {
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
  const [n] = await t.sql`select count(*)::int as n from handles where handle = 'tech-lead-orph'`;
  expect(n?.n).toBe(0);
});

test("a template that is missing or invalid on disk is refused before anything is made", async () => {
  const { t, lead } = await setup();
  writeTemplate(t.factoryHome, "dev", "name: dev\nruntime: nonsense\n");
  const before = folders(t);
  expect(await t.app.spawner.spawn(lead.id, args({ template: "dev" }), null)).toEqual({
    ok: false,
    message: "Template dev is missing or invalid; ask a human (list_peers lists them) to fix it.",
  });
  expect(folders(t)).toEqual(before);
});

test("I2 §6.2: a spawner whose current config can't be read refuses before anything is made", async () => {
  const { t, lead } = await setup();
  await t.sql`update agents set config = '{"bogus":1}'::jsonb where id = ${lead.id}`;
  const before = folders(t);
  expect(await t.app.spawner.spawn(lead.id, args(), null)).toEqual({
    ok: false,
    message: "Your configuration can't be read; ask a human (list_peers lists them) to fix it.",
  });
  expect(folders(t)).toEqual(before);
});

test("I2 §6.2: the cap and allowlist are started's; secrets are the stricter of started and current", async () => {
  const { t, lead } = await setup();
  // The current overlay drops tech-lead and GH_TOKEN; the running process still started with both.
  await t.sql`update agents set config = '{"template":{"can_spawn":["dev"],"max_live_spawns":5}}'::jsonb where id = ${lead.id}`;
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
  const boss = await t.seedAgent({ slug: "boss" });
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
