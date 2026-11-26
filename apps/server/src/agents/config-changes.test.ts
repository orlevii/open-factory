import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConfigDoc, describeChanges, mergeConfig } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { FILE_CHANGE, TemplateIndex } from "../templates/template-index.ts";
import { folderSource, hostOnlyLibrary } from "../test/library.ts";
import { ConfigChanges, dbConfigChangeAgents } from "./config-changes.ts";
import type { ConfigResolver, Effective } from "./config-resolver.ts";
import { AgentStartError } from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import { parseConfigNotice } from "./notices.ts";
import { PolicyInputs } from "./policy-inputs.ts";
import { AgentRuntimes } from "./runtimes.ts";
import type { PrepareStart } from "./start.ts";
import { ev, FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import {
  noForward,
  noopTokens,
  okSpec,
  RuntimeHarness,
  silentLog,
  testEffective,
} from "./testing/runtime-harness.ts";

/** I2 §7.2 over a test DB and real runtimes (fake driver): the SQL reads, the rows written and the restart decision. */
const h = new RuntimeHarness();
beforeAll(() => h.setup());
afterAll(() => h.close());
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const SECRET = "ghp_TOPSECRETvalue1234567890";

const doc = (template: Record<string, unknown> = {}, more: Partial<ConfigDoc> = {}): ConfigDoc => ({
  template: { name: "test", display_name: "Test agent", runtime: "local", ...template },
  settings: {},
  mcp: { mcpServers: {} },
  ...more,
});

let n = 0;
async function agent(o: Omit<Parameters<typeof insertAgent>[1], "id" | "slug"> = {}) {
  n += 1;
  const id = `cc${n}`;
  await insertAgent(h.t.sql, { id, slug: `cc-${n}`, ...o });
  return id;
}
async function rowOf(id: string) {
  const row = await h.store.agentById(id);
  if (!row) throw new Error(`no agent ${id}`);
  return row;
}

/** A resolver for the SQL reads alone: it hands back the row's overlay as the doc's settings. */
const echoResolver: Pick<ConfigResolver, "effective"> = {
  effective: async (row) => ({ ...testEffective(), doc: { ...doc(), settings: row.config } }),
};

const NO_LIBRARY = { skills: {} };
const snap = (d: ConfigDoc) => ({ doc: d, library: NO_LIBRARY });
/** A config check that reads `d` (what the runtime's job sees when it re-reads the agent). */
const at = (d: ConfigDoc | undefined) => ({ current: async () => (d ? snap(d) : undefined) });

/**
 * Runtimes whose every start runs on `startedDoc` (what `started` holds), plus the change path over them. `current`
 * is each agent's effective doc as the runtime's re-read sees it (the committed state), `reads` counts those reads.
 */
function world(
  startedDoc: ConfigDoc,
  startedLibrary: Effective["library"] = NO_LIBRARY,
  libraryOf: (d: ConfigDoc) => Effective["library"] = () => NO_LIBRARY,
) {
  const driver = new FakeDriver();
  const prepareStart: PrepareStart = async (a) => {
    const effective: Effective = { ...testEffective(), doc: startedDoc, library: startedLibrary };
    return { ...okSpec(a), effective };
  };
  const bus = new EventBus();
  const frames: unknown[] = [];
  bus.subscribeAll((m) => frames.push(m));
  const runtimes = new AgentRuntimes({
    store: h.store,
    bus,
    driver,
    prepareStart,
    tokens: noopTokens,
    log: silentLog,
    forward: noForward,
  });
  closers.push(() => runtimes.stopAll());
  const current = new Map<string, ConfigDoc>();
  /** The Library's resolution now, which a re-read returns beside the doc. */
  let libraryNow: Effective["library"] = NO_LIBRARY;
  let reads = 0;
  const changes = new ConfigChanges({
    agents: {
      ...dbConfigChangeAgents(h.t.db, echoResolver),
      currentEffective: async (id) => {
        reads += 1;
        const d = current.get(id);
        return d ? { doc: d, library: libraryNow } : undefined;
      },
    },
    store: h.store,
    runtimes,
    bus,
    log: silentLog,
    resolver: { libraryOf: async (d) => libraryOf(d) },
    templates: { scan: async () => [] },
  });
  /** Starts the agent and leaves a turn open, so a requested restart stays pending. */
  const runBusy = async (agentId: string) => {
    const row = await h.store.createMessage({
      from: { userId: "u1" },
      toAgentId: agentId,
      recipientIds: [agentId],
      body: "hi",
      urgent: false,
    });
    await runtimes.deliver(row, "human");
    driver.last.emit(...ev.fullTurn("sess-1"), ev.turn());
    const rt = await runtimes.get(agentId);
    await rt?.settled();
    return rt;
  };
  return {
    driver,
    runtimes,
    changes,
    frames,
    runBusy,
    current,
    reads: () => reads,
    setLibrary: (l: Effective["library"]) => {
      libraryNow = l;
    },
  };
}

const events = (agentId: string) =>
  h.t.sql<{ type: string; payload: { by: string; changes: string[] } }[]>`
    select type, payload from session_events where agent_id = ${agentId} and type = 'config_changed'`;
const noticeLines = async (agentId: string) => {
  const rows = await h.t.sql<{ body: string }[]>`
    select body from messages where to_id = ${agentId} and notice = 'config_changed' and state = 'pending'`;
  return rows.map((r) => parseConfigNotice(r.body));
};

test("the SQL reads: live agents of a template, persistent and spawned, never archived or terminated; live children", async () => {
  const lead = await agent();
  const kid = await agent({ kind: "ephemeral", reportsTo: lead });
  // Ephemeral, so only the terminated filter can exclude it.
  const gone = await agent({ kind: "ephemeral", reportsTo: lead, terminatedAt: new Date() });
  const archived = await agent({ archived: true });
  await h.t.sql`update agents set template = 'other' where id = ${archived}`;
  const q = dbConfigChangeAgents(h.t.db, echoResolver);
  const ids = (await q.liveOfTemplate("test")).map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining([lead, kid]));
  expect(ids).not.toContain(gone);
  await h.t.sql`update agents set template = 'test' where id = ${archived}`;
  expect((await q.liveOfTemplate("test")).map((r) => r.id)).not.toContain(archived);
  expect(await q.liveChildren(lead)).toEqual([kid]);
});

test("currentEffective resolves the row as it is now; undefined for a gone agent or a config that can't be resolved", async () => {
  const id = await agent();
  const q = dbConfigChangeAgents(h.t.db, echoResolver);
  await h.t
    .sql`update agents set config = ${JSON.stringify({ template: { model: "opus" } })}::jsonb where id = ${id}`;
  expect((await q.currentEffective(id))?.doc.settings).toEqual({ template: { model: "opus" } });
  expect((await q.currentEffective(id))?.library).toEqual(NO_LIBRARY);
  expect(await q.currentEffective("no-such-agent")).toBeUndefined();
  const failing = dbConfigChangeAgents(h.t.db, {
    effective: async () => {
      throw new AgentStartError("Template test has errors. Fix it in Templates.", "template");
    },
  });
  expect(await failing.currentEffective(id)).toBeUndefined();
});

test("a template change with a new skill: event and notice for each live agent; restart only where started differs", async () => {
  const before = doc({ skills: ["tdd"] });
  const after = doc({ skills: ["tdd", "release"] });
  const w = world(before);
  // Fresh template rows so this test's agents are the only ones of `t-skill`.
  const running = await agent();
  const idle = await agent();
  const spawned = await agent({ kind: "ephemeral", reportsTo: running });
  const archived = await agent({ archived: true });
  for (const id of [running, idle, spawned, archived])
    await h.t.sql`update agents set template = 't-skill' where id = ${id}`;
  const rt = await w.runBusy(running);
  w.current.set(running, after);
  await w.changes.templateChanged({ name: "t-skill", before, after, by: FILE_CHANGE });
  await rt?.settled();

  for (const id of [running, idle, spawned]) {
    expect((await events(id)).map((e) => e.payload)).toEqual([
      { by: "a file change in template t-skill", changes: ["added skill release"] },
    ]);
    expect(await noticeLines(id)).toEqual([["added skill release"]]);
  }
  // Archived agents are skipped entirely.
  expect(await events(archived)).toEqual([]);
  expect(await noticeLines(archived)).toEqual([]);
  // The running one started on `before`: it restarts to apply exactly that line.
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["added skill release"],
  });
  expect(w.frames).toEqual(
    expect.arrayContaining([{ type: "config_changed", template: "t-skill" }]),
  );
});

test("a start already running on the new config doesn't restart (compared in the runtime's job)", async () => {
  const after = doc({ model: "opus" });
  const w = world(after);
  const id = await agent();
  const rt = await w.runBusy(id);
  await w.runtimes.requestRestart(id, at(after));
  expect(rt?.live()).toMatchObject({ restartPending: false, restartChanges: [] });
  await w.runtimes.requestRestart(id, at(doc({ model: "haiku" })));
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["model: opus → haiku"],
  });
});

test("two edits that cancel out while busy drop the pending restart; a second edit replaces the lines", async () => {
  const w = world(doc({ model: "opus" }));
  const id = await agent();
  const rt = await w.runBusy(id);
  await w.runtimes.requestRestart(id, at(doc({ model: "haiku" })));
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["model: opus → haiku"],
  });
  // Edit then edit: exactly the started → latest line.
  await w.runtimes.requestRestart(id, at(doc({ model: "sonnet" })));
  expect(rt?.live().restartChanges).toEqual(["model: opus → sonnet"]);
  // Revert: nothing to apply, so nothing restarts.
  await w.runtimes.requestRestart(id, at(doc({ model: "opus" })));
  expect(rt?.live()).toMatchObject({ restartPending: false, restartChanges: [] });
  // The cleared state is published (the restart line goes away in every open view).
  const statuses = w.frames.filter(
    (f): f is { type: string; agent: string; restartPending: boolean } =>
      (f as { type?: string }).type === "agent_status",
  );
  expect(statuses.at(-1)).toMatchObject({ restartPending: false, restartChanges: [] });
});

test("a revert keeps a restart another cause asked for, without the config lines", async () => {
  const w = world(doc({ model: "opus" }));
  const id = await agent();
  const rt = await w.runBusy(id);
  await w.runtimes.requestRestart(id, at(doc({ model: "haiku" })));
  await w.runtimes.requestRestart(id); // e.g. a credential change
  await w.runtimes.requestRestart(id, at(doc({ model: "opus" })));
  expect(rt?.live()).toMatchObject({ restartPending: true, restartChanges: [] });
});

test("a config that can't be read now leaves the pending restart as it is", async () => {
  const w = world(doc({ model: "opus" }));
  const id = await agent();
  const rt = await w.runBusy(id);
  await w.runtimes.requestRestart(id, at(undefined));
  expect(rt?.live()).toMatchObject({ restartPending: false, restartChanges: [] });
  await w.runtimes.requestRestart(id, at(doc({ model: "haiku" })));
  await w.runtimes.requestRestart(id, at(undefined));
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["model: opus → haiku"],
  });
});

/*
 * I2 §7.2, the races: each change path computes its `after` from rows it read earlier, and the two paths aren't
 * serialized per agent. Whichever request reaches the runtime last, the decision is made against the config committed
 * now (`current`), so a request built on stale reads can't cancel a restart the newer change needs.
 */
test("a stale template dispatch arriving after an overlay save doesn't cancel the save's restart", async () => {
  const A = doc();
  const B = doc({ skills: ["x"] });
  const oNew = { template: { model: "opus" } };
  // The process started on the new template with the old (empty) overlay; the save then committed `oNew`.
  const started = mergeConfig(B, {});
  const committed = mergeConfig(B, oNew);
  const w = world(started);
  const id = await agent();
  await h.t.sql`update agents set template = 't-race1' where id = ${id}`;
  const rt = await w.runBusy(id);
  w.current.set(id, committed);
  // The overlay PUT's request, then the template dispatch that read the row before the PUT committed (its row still
  // holds the empty overlay, so its `after` equals what the process started with).
  await w.changes.overlaySaved(
    await rowOf(id),
    { kind: "human", handle: "or" },
    started,
    committed,
  );
  await w.changes.templateChanged({ name: "t-race1", before: A, after: B, by: FILE_CHANGE });
  await rt?.settled();
  expect(w.reads()).toBe(2);
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: describeChanges(snap(started), snap(committed)),
  });
});

test("an overlay save built on a stale base arriving after a template change doesn't cancel the template's restart", async () => {
  const A = doc();
  const B = doc({ skills: ["x"] });
  // The process started on the old template; the template then moved to B.
  const started = mergeConfig(A, {});
  const committed = mergeConfig(B, {});
  const w = world(started);
  const id = await agent();
  await h.t.sql`update agents set template = 't-race2' where id = ${id}`;
  const rt = await w.runBusy(id);
  w.current.set(id, committed);
  await w.changes.templateChanged({ name: "t-race2", before: A, after: B, by: FILE_CHANGE });
  expect(rt?.live()).toMatchObject({ restartPending: true });
  // An overlay revert whose base was read before the template change: its `after` equals what the process started on.
  await w.changes.overlaySaved(
    await rowOf(id),
    { kind: "human", handle: "or" },
    mergeConfig(A, { template: { model: "haiku" } }),
    started,
  );
  await vi.waitFor(() => expect(w.reads()).toBe(2));
  await rt?.settled();
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: describeChanges(snap(started), snap(committed)),
  });
});

test("an overlay save on an archived agent writes the event only; values never reach rows", async () => {
  const w = world(doc());
  const id = await agent({ archived: true });
  const out = await w.changes.overlaySaved(
    await rowOf(id),
    { kind: "human", handle: "or" },
    doc(),
    doc({}, { settings: { env: { GH: SECRET } } }),
  );
  expect(out).toEqual({ changes: ["env GH added"], restartChecked: false });
  expect((await events(id)).map((e) => e.payload)).toEqual([
    { by: "@or", changes: ["env GH added"] },
  ]);
  expect(await noticeLines(id)).toEqual([]);
  const all = await h.t.sql`select payload::text as p from session_events where agent_id = ${id}`;
  expect(JSON.stringify(all)).not.toContain(SECRET);
});

const GH = (c: string) => `github:${c.repeat(40)}`;

test("a GitHub update writes config_changed for every agent using the skill and requests a restart only for the running one, compared against started.library", async () => {
  const d = doc({ skills: ["tdd"] });
  const w = world(d, { skills: { tdd: GH("a") } });
  const user = await agent();
  const bystander = await agent();
  const rt = await w.runBusy(user);
  w.current.set(user, d);
  w.current.set(bystander, d);
  w.setLibrary({ skills: { tdd: GH("b") } });
  await w.changes.libraryChanged({
    skills: ["tdd"],
    by: "orlevi",
    before: { skills: { tdd: GH("a") } },
  });
  await rt?.settled();

  const line = "skill tdd updated aaaaaaa → bbbbbbb";
  expect((await events(user)).map((e) => e.payload)).toEqual([{ by: "orlevi", changes: [line] }]);
  expect(rt?.live()).toMatchObject({ restartPending: true, restartChanges: [line] });
  // Not running: it gets the event too, from the Library captured before the change, and no restart.
  expect((await events(bystander)).map((e) => e.payload)).toEqual([
    { by: "orlevi", changes: [line] },
  ]);
  // A name nobody uses changes nothing.
  await w.changes.libraryChanged({ skills: ["release"], by: "orlevi" });
  expect((await events(user)).length).toBe(1);
  expect((await events(bystander)).length).toBe(1);
});

test("a template whose skill became missing shows the issue after libraryChanged, not before", async () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "of-lib-cc-")));
  const src = path.join(home, "src");
  mkdirSync(path.join(src, "tdd"), { recursive: true });
  writeFileSync(path.join(src, "tdd", "SKILL.md"), "---\nname: tdd\n---\n# tdd\n");
  const dir = path.join(home, "templates", "lib-t");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "template.yaml"), "name: lib-t\ndisplay_name: T\nskills: [tdd]\n");
  writeFileSync(path.join(dir, "AGENTS.md"), "# T\n");
  const cfg = loadConfig({
    DATABASE_URL: h.t.url,
    FACTORY_SECRET_KEY: "k".repeat(40),
    FACTORY_HOME: home,
  });
  const library = hostOnlyLibrary(path.join(home, "claude"), home, [folderSource(src, ["tdd"])]);
  const templates = new TemplateIndex({
    db: h.t.db,
    config: cfg,
    library,
    policy: new PolicyInputs({ db: h.t.db }),
  });
  await templates.scan();
  const problem = "Skill tdd is missing from its folder.";
  const messages = async () =>
    (
      await h.t.sql<{ issues: { message: string }[] }[]>`
        select issues from templates where name = 'lib-t'`
    ).flatMap((r) => r.issues.map((i) => i.message));
  expect(await messages()).not.toContain(problem);

  rmSync(path.join(src, "tdd"), { recursive: true });
  // The stored issues are as of the last scan until the change is announced.
  expect(await messages()).not.toContain(problem);
  const changes = new ConfigChanges({
    agents: dbConfigChangeAgents(h.t.db, echoResolver),
    store: h.store,
    runtimes: { startedOf: () => undefined } as never,
    bus: new EventBus(),
    log: silentLog,
    resolver: { libraryOf: async () => NO_LIBRARY },
    templates,
  });
  await changes.libraryChanged({ skills: ["tdd"], by: "orlevi" });
  expect(await messages()).toContain(problem);
  rmSync(home, { recursive: true, force: true });
});
