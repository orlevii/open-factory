import type { ConfigDoc } from "@open-factory/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { FILE_CHANGE } from "../templates/template-index.ts";
import { ConfigChanges, dbConfigChangeAgents } from "./config-changes.ts";
import type { Effective } from "./config-resolver.ts";
import { EventBus } from "./event-bus.ts";
import { parseConfigNotice } from "./notices.ts";
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

/** Runtimes whose every start runs on `startedDoc` (what `started` holds), plus the change path over them. */
function world(startedDoc: ConfigDoc) {
  const driver = new FakeDriver();
  const prepareStart: PrepareStart = async (a) => {
    const effective: Effective = { ...testEffective(), doc: startedDoc };
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
  const changes = new ConfigChanges({
    agents: dbConfigChangeAgents(h.t.db),
    store: h.store,
    runtimes,
    bus,
    log: silentLog,
  });
  /** Starts the agent and leaves a turn open, so a requested restart stays pending. */
  const runBusy = async (agentId: string) => {
    const row = await h.store.createMessage({
      from: { userId: "u1" },
      toAgentId: agentId,
      recipients: ["@x"],
      body: "hi",
      urgent: false,
    });
    await runtimes.deliver(row, "human");
    driver.last.emit(...ev.fullTurn("sess-1"), ev.turn());
    const rt = await runtimes.get(agentId);
    await rt?.settled();
    return rt;
  };
  return { driver, runtimes, changes, frames, runBusy };
}

const events = (agentId: string) =>
  h.t.sql<{ type: string; payload: { by: string; changes: string[] } }[]>`
    select type, payload from session_events where agent_id = ${agentId} and type = 'config_changed'`;
const noticeLines = async (agentId: string) => {
  const rows = await h.t.sql<{ body: string }[]>`
    select body from messages where to_agent_id = ${agentId} and notice = 'config_changed' and state = 'pending'`;
  return rows.map((r) => parseConfigNotice(r.body));
};

test("the SQL reads: live agents of a template, persistent and spawned, never archived or terminated; live children", async () => {
  const lead = await agent();
  const kid = await agent({ kind: "ephemeral", reportsTo: lead });
  const gone = await agent({ reportsTo: lead, terminatedAt: new Date() });
  const archived = await agent({ archived: true });
  await h.t.sql`update agents set template = 'other' where id = ${archived}`;
  const q = dbConfigChangeAgents(h.t.db);
  const ids = (await q.liveOfTemplate("test")).map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining([lead, kid]));
  expect(ids).not.toContain(gone);
  await h.t.sql`update agents set template = 'test' where id = ${archived}`;
  expect((await q.liveOfTemplate("test")).map((r) => r.id)).not.toContain(archived);
  expect(await q.liveChildren(lead)).toEqual([kid]);
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
  await w.runtimes.requestRestart(id, { after });
  expect(rt?.live()).toMatchObject({ restartPending: false, restartChanges: [] });
  await w.runtimes.requestRestart(id, { after: doc({ model: "haiku" }) });
  expect(rt?.live()).toMatchObject({
    restartPending: true,
    restartChanges: ["model: opus → haiku"],
  });
});

test("before: null writes no event or notice but still restarts a process that started on something else", async () => {
  const w = world(doc());
  const id = await agent();
  await h.t.sql`update agents set template = 't-null' where id = ${id}`;
  const rt = await w.runBusy(id);
  await w.changes.templateChanged({
    name: "t-null",
    before: null,
    after: doc({ skills: ["x"] }),
    by: FILE_CHANGE,
  });
  await rt?.settled();
  expect(await events(id)).toEqual([]);
  expect(await noticeLines(id)).toEqual([]);
  expect(rt?.live()).toMatchObject({ restartPending: true, restartChanges: ["added skill x"] });
});

test("a spawner whose secrets changed restarts its live children", async () => {
  const w = world(doc());
  const lead = await agent();
  const kid = await agent({ kind: "ephemeral", reportsTo: lead });
  const kidRt = await w.runBusy(kid);
  await w.changes.overlaySaved(
    await rowOf(lead),
    "@or",
    doc({ secrets: ["GH_TOKEN"] }),
    doc({ secrets: [] }),
  );
  await vi.waitFor(() => expect(kidRt?.live().restartPending).toBe(true));
});

test("an overlay save on an archived agent writes the event only; values never reach rows", async () => {
  const w = world(doc());
  const id = await agent({ archived: true });
  const out = await w.changes.overlaySaved(
    await rowOf(id),
    "@or",
    doc(),
    doc({}, { settings: { env: { GH: SECRET } } }),
  );
  expect(out).toEqual({ changes: ["env GH changed"], restart: false });
  expect((await events(id)).map((e) => e.payload)).toEqual([
    { by: "@or", changes: ["env GH changed"] },
  ]);
  expect(await noticeLines(id)).toEqual([]);
  const all = await h.t.sql`select payload::text as p from session_events where agent_id = ${id}`;
  expect(JSON.stringify(all)).not.toContain(SECRET);
});

test("nextImage is refreshed for a loaded Docker runtime", async () => {
  const w = world(doc());
  const id = await agent();
  await h.t.sql`update agents set runtime = 'docker', template = 't-img' where id = ${id}`;
  const rt = await w.runtimes.load(id);
  // Without Docker deps the runtimes resolve no ref; the change path still sets what `imageRef` gives.
  const spy = vi.spyOn(w.runtimes, "imageRef").mockReturnValue("img:new");
  await w.changes.templateChanged({
    name: "t-img",
    before: doc({ runtime: "docker", image: "img:old" }),
    after: doc({ runtime: "docker", image: "img:new" }),
    by: FILE_CHANGE,
  });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: "docker", image: "img:new" }),
  );
  expect(rt?.nextImage).toBe("img:new");
});
