import type { AgentRow } from "@open-factory/db";
import type { AnyEvent, ConfigDoc, ConfigSnapshot, ServerMessage } from "@open-factory/shared";
import { expect, test } from "vitest";
import { FILE_CHANGE } from "../templates/template-index.ts";
import { ConfigChanges } from "./config-changes.ts";
import type { Effective } from "./config-resolver.ts";

/**
 * I2 §7.2 without a database: the change flow over fake runtimes, store and bus (the SQL reads are covered by
 * config-changes.test.ts in CI).
 */

const SECRET = "ghp_TOPSECRETvalue1234567890";
const MCP_URL = `https://user:${SECRET}@mcp.example.com/sse`;

const doc = (template: Record<string, unknown> = {}, more: Partial<ConfigDoc> = {}): ConfigDoc => ({
  template: { name: "dev", display_name: "Dev", runtime: "local", ...template },
  settings: {},
  mcp: { mcpServers: {} },
  ...more,
});

let n = 0;
const row = (o: Partial<AgentRow> = {}): AgentRow => {
  n += 1;
  return {
    id: `a${n}`,
    slug: `dev-${n}`,
    displayName: "Dev",
    description: "",
    sessionId: null,
    status: "hibernated",
    kind: "persistent",
    template: "dev",
    config: {},
    runtime: "local",
    reportsTo: null,
    credentialId: "c1",
    lastError: null,
    errorKind: null,
    attempting: false,
    erroredReported: false,
    runtimeJournal: null,
    rateLimitNoticeOwed: false,
    archivedAt: null,
    terminatedAt: null,
    terminatedBy: null,
    workspacePinned: false,
    workspaceDeletedAt: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  } as AgentRow;
};

type Rt = {
  running: boolean;
  appended: { by: string; changes: string[] }[];
  /** When set, the runtime's jobs never finish (a start stuck installing a plugin). */
  stuck?: boolean;
};

/** What the Library resolves a doc to in these tests: `refs[name]`, "host" for a name it doesn't list. */
const resolvedTo =
  (refs: Record<string, string>) =>
  async (d: ConfigDoc): Promise<ConfigSnapshot["library"]> => {
    const listed = Array.isArray(d.template.skills) ? (d.template.skills as string[]) : [];
    return { skills: Object.fromEntries(listed.map((n) => [n, refs[n] ?? "host"])), plugins: {} };
  };

function world(o: { agents?: AgentRow[]; children?: Record<string, string[]> } = {}) {
  const runtimes = new Map<string, Rt>();
  const appendedToStore: { agentId: string; event: AnyEvent }[] = [];
  const notices: { id: string; lines: string[] }[] = [];
  /** `current` is what the request's re-read returned (absent for a restart with no config check). */
  const restarts: { id: string; current?: ConfigSnapshot | undefined }[] = [];
  /** What `currentEffective` reads for an agent now (its fresh row through the resolver). */
  const fresh = new Map<string, ConfigSnapshot>();
  /** What a running agent's process started with (`startedOf`). */
  const started = new Map<string, Effective>();
  /** The Library's resolution of each skill name now. */
  const refs: Record<string, string> = {};
  let scans = 0;
  const nextImage = new Map<string, string | undefined>();
  const frames: ServerMessage[] = [];
  const logged: unknown[] = [];
  const never = new Promise<void>(() => {});
  const stuckOf = (id: string) => runtimes.get(id)?.stuck === true;
  const changes = new ConfigChanges({
    agents: {
      liveOfTemplate: async () => o.agents ?? [],
      liveChildren: async (id) => o.children?.[id] ?? [],
      allLive: async () => o.agents ?? [],
      currentEffective: async (id) => fresh.get(id),
    },
    resolver: { libraryOf: (d: ConfigDoc) => resolvedTo(refs)(d) },
    templates: {
      scan: async () => {
        scans += 1;
      },
    },
    store: {
      append: async (agentId: string, _turn: string | null, event: AnyEvent) => {
        appendedToStore.push({ agentId, event });
        return {} as never;
      },
    },
    runtimes: {
      get: async (id: string) => {
        const rt = runtimes.get(id);
        if (!rt) return undefined;
        return {
          hasProcess: () => rt.running,
          appendConfigChanged: async (by: string, c: string[]) => {
            if (rt.stuck) return never;
            rt.appended.push({ by, changes: c });
          },
        } as never;
      },
      recordConfigNotice: async (id: string, lines: string[]) => {
        if (stuckOf(id)) return never;
        notices.push({ id, lines });
      },
      requestRestart: async (
        id: string,
        opts?: { current?: () => Promise<ConfigSnapshot | undefined> },
      ) => {
        if (stuckOf(id)) return never;
        restarts.push(opts?.current ? { id, current: await opts.current() } : { id });
      },
      setNextImage: (id: string, ref: string | undefined) => void nextImage.set(id, ref),
      imageRef: (c: { runtime: string; image?: string }) =>
        c.runtime === "docker" ? (c.image ?? "img:default") : undefined,
      startedOf: (id: string): Effective | undefined => started.get(id),
    },
    bus: { publishAll: (m: ServerMessage) => void frames.push(m) },
    log: { error: (obj: unknown) => void logged.push(obj) },
  });
  const load = (a: AgentRow, running: boolean, stuck = false) => {
    const rt: Rt = { running, appended: [], stuck };
    runtimes.set(a.id, rt);
    return rt;
  };
  return {
    changes,
    load,
    appendedToStore,
    notices,
    restarts,
    fresh,
    started,
    refs,
    scans: () => scans,
    nextImage,
    frames,
    logged,
  };
}

test("a new skill: every live agent of the template, persistent and spawned, gets the event and the notice; only running ones get the restart check", async () => {
  const running = row();
  const idle = row();
  const spawned = row({ kind: "ephemeral", reportsTo: running.id });
  const w = world({ agents: [running, idle, spawned] });
  const rtRunning = w.load(running, true);
  const rtIdle = w.load(idle, false);
  const before = doc({ skills: ["tdd"] });
  const after = doc({ skills: ["tdd", "release"] });
  // What the runtime's job will read: newer than this change's `after` (an overlay save landed since).
  const latest = doc({ skills: ["tdd", "release"], model: "opus" });
  w.fresh.set(running.id, {
    doc: latest,
    library: { skills: { tdd: "host", release: "host" }, plugins: {} },
  });
  await w.changes.templateChanged({ name: "dev", before, after, by: FILE_CHANGE });

  const by = "a file change in template dev";
  // Loaded: through the runtime (it publishes); not loaded: straight to the store.
  expect(rtRunning.appended).toEqual([{ by, changes: ["added skill release"] }]);
  expect(rtIdle.appended).toEqual([{ by, changes: ["added skill release"] }]);
  expect(w.appendedToStore).toEqual([
    {
      agentId: spawned.id,
      event: { type: "config_changed", by, changes: ["added skill release"] },
    },
  ]);
  expect(w.notices.map((x) => x.id).sort()).toEqual([running.id, idle.id, spawned.id].sort());
  // Decided in the runtime's job, which re-reads that agent's config there rather than trusting this change's `after`.
  expect(w.restarts).toEqual([
    {
      id: running.id,
      current: { doc: latest, library: { skills: { tdd: "host", release: "host" }, plugins: {} } },
    },
  ]);
  expect(w.frames).toEqual([
    { type: "config_changed", template: "dev" },
    { type: "config_changed", agent: running.slug },
    { type: "config_changed", agent: idle.slug },
    { type: "config_changed", agent: spawned.slug },
  ]);
});

test("an API write names the template; the overlay is merged on both sides, so an overridden key changes nothing", async () => {
  const pinned = row({ config: { template: { model: "opus" } } });
  const plain = row();
  const w = world({ agents: [pinned, plain] });
  await w.changes.templateChanged({
    name: "dev",
    before: doc({ model: "sonnet" }),
    after: doc({ model: "haiku" }),
    by: "@orlevi",
  });
  expect(w.appendedToStore).toEqual([
    {
      agentId: plain.id,
      event: { type: "config_changed", by: "template dev", changes: ["model: sonnet → haiku"] },
    },
  ]);
  expect(w.notices.map((x) => x.id)).toEqual([plain.id]);
});

test("an AGENTS.md-only change (the same docs) reaches no agent, but the template's views still hear of it", async () => {
  const a = row();
  const w = world({ agents: [a] });
  w.load(a, true);
  // Keys that never reach a running agent move no line either.
  await w.changes.templateChanged({
    name: "dev",
    before: doc({ description: "old" }),
    after: doc({ description: "new" }),
    by: FILE_CHANGE,
  });
  expect([w.appendedToStore, w.notices, w.restarts]).toEqual([[], [], []]);
  expect(w.frames).toEqual([{ type: "config_changed", template: "dev" }]);
});

test("before: null writes no event or notice but still runs the restart check", async () => {
  const running = row();
  const idle = row();
  const w = world({ agents: [running, idle] });
  const rt = w.load(running, true);
  w.load(idle, false);
  const after = doc({ skills: ["release"] });
  w.fresh.set(running.id, { doc: after, library: { skills: { release: "host" }, plugins: {} } });
  await w.changes.templateChanged({ name: "dev", before: null, after, by: FILE_CHANGE });
  expect(rt.appended).toEqual([]);
  expect(w.appendedToStore).toEqual([]);
  expect(w.notices).toEqual([]);
  expect(w.restarts).toEqual([
    {
      id: running.id,
      current: { doc: after, library: { skills: { release: "host" }, plugins: {} } },
    },
  ]);
  expect(w.frames).toEqual([{ type: "config_changed", template: "dev" }]);
});

test("an agent with an invalid overlay is skipped and its next image cleared (its start fails closed)", async () => {
  const bad = row({ runtime: "docker", config: { bogus: 1 } as never });
  const w = world({ agents: [bad] });
  w.load(bad, true);
  await w.changes.templateChanged({
    name: "dev",
    before: doc({ skills: [] }),
    after: doc({ skills: ["x"] }),
    by: FILE_CHANGE,
  });
  expect([w.appendedToStore, w.notices, w.restarts]).toEqual([[], [], []]);
  expect(w.nextImage.get(bad.id)).toBeUndefined();
  expect(w.nextImage.has(bad.id)).toBe(true);
});

test("a spawner whose secrets or deny rules changed restarts its live children; a skill change doesn't", async () => {
  const lead = row({ config: {} });
  const w = world({ agents: [lead], children: { [lead.id]: ["kid-1", "kid-2"] } });
  const tpl = (t: Record<string, unknown>, settings: Record<string, unknown> = {}) =>
    doc({ can_spawn: ["dev"], ...t }, { settings });

  await w.changes.templateChanged({
    name: "dev",
    before: tpl({ secrets: ["GH_TOKEN"] }),
    after: tpl({ secrets: [] }),
    by: FILE_CHANGE,
  });
  expect(w.restarts.map((r) => r.id).sort()).toEqual(["kid-1", "kid-2"]);
  // Children re-derive at their start: no config of theirs to compare.
  expect(w.restarts.every((r) => !("current" in r))).toBe(true);

  w.restarts.length = 0;
  await w.changes.overlaySaved(
    lead,
    "@orlevi",
    tpl({}),
    tpl({}, { permissions: { deny: ["Bash(rm:*)"] } }),
  );
  await new Promise((r) => setImmediate(r));
  expect(w.restarts.map((r) => r.id).sort()).toEqual(["kid-1", "kid-2"]);

  w.restarts.length = 0;
  await w.changes.overlaySaved(lead, "@orlevi", tpl({ skills: [] }), tpl({ skills: ["x"] }));
  await new Promise((r) => setImmediate(r));
  expect(w.restarts).toEqual([]);
});

test("an overlay save on an archived agent writes the event only", async () => {
  const a = row({ archivedAt: new Date(), runtime: "docker" });
  const w = world();
  const out = await w.changes.overlaySaved(a, "@orlevi", doc(), doc({ model: "opus" }));
  expect(out).toEqual({ changes: ["model: default → opus"], restartChecked: false });
  expect(w.appendedToStore).toEqual([
    {
      agentId: a.id,
      event: { type: "config_changed", by: "@orlevi", changes: ["model: default → opus"] },
    },
  ]);
  expect([w.notices, w.restarts]).toEqual([[], []]);
  expect(w.nextImage.size).toBe(0);
  expect(w.frames).toEqual([{ type: "config_changed", agent: a.slug }]);
});

test("nextImage is refreshed with the image the new config resolves to", async () => {
  const a = row({ runtime: "docker" });
  const w = world({ agents: [a] });
  w.load(a, false);
  await w.changes.templateChanged({
    name: "dev",
    before: doc({ runtime: "docker", image: "img:old" }),
    after: doc({ runtime: "docker", image: "img:new" }),
    by: FILE_CHANGE,
  });
  expect(w.nextImage.get(a.id)).toBe("img:new");
});

test("overlaySaved never waits on the runtime's queue (a start installing a plugin)", async () => {
  const a = row();
  const w = world();
  w.load(a, true, true);
  const out = await w.changes.overlaySaved(a, "@orlevi", doc(), doc({ model: "opus" }));
  expect(out).toEqual({ changes: ["model: default → opus"], restartChecked: true });
});

test("secret safety: no env value, MCP URL or command reaches an event, a notice, a frame or a log", async () => {
  const a = row();
  const kid = "kid-1";
  const w = world({ agents: [a], children: { [a.id]: [kid] } });
  const rt = w.load(a, true);
  const before = doc({}, { settings: { env: { GH: "old" } }, mcp: { mcpServers: {} } });
  const after = doc(
    { secrets: ["GH_TOKEN"] },
    {
      settings: { env: { GH: SECRET }, hooks: { x: SECRET } },
      mcp: { mcpServers: { github: { command: `run-${SECRET}`, url: MCP_URL } } },
    },
  );
  // The fixture does carry the value, so the checks below can fail.
  expect(JSON.stringify(after)).toContain(SECRET);
  const out = await w.changes.overlaySaved(a, "@orlevi", before, after);
  await new Promise((r) => setImmediate(r));
  const seen = JSON.stringify([out, rt.appended, w.appendedToStore, w.notices, w.frames, w.logged]);
  expect(seen).not.toContain(SECRET);
  expect(seen).not.toContain("mcp.example.com");
  expect(out.changes).toEqual([
    "MCP server github added",
    "added secret GH_TOKEN",
    "env GH changed",
    "settings key hooks changed",
  ]);
});

const startedWith = (d: ConfigDoc, skills: Record<string, string>): Effective =>
  ({ doc: d, config: {}, templatePlugins: [], library: { skills, plugins: {} } }) as never;
const GH = (c: string) => `github:${c.repeat(40)}`;

test("a library change rescans the templates, then restarts only a running agent that uses the skill, against started.library", async () => {
  const d = doc({ skills: ["tdd"] });
  const user = row();
  const other = row();
  const idle = row();
  const w = world({ agents: [user, other, idle] });
  const rtUser = w.load(user, true);
  const rtOther = w.load(other, true);
  w.load(idle, false);
  w.started.set(user.id, startedWith(d, { tdd: GH("a") }));
  w.started.set(other.id, startedWith(doc({ skills: ["release"] }), { release: "host" }));
  w.fresh.set(user.id, { doc: d, library: { skills: { tdd: GH("b") }, plugins: {} } });
  w.fresh.set(other.id, { doc: d, library: { skills: { release: "host" }, plugins: {} } });
  await w.changes.libraryChanged({ skills: ["tdd"], by: "orlevi" });

  expect(w.scans()).toBe(1);
  expect(rtUser.appended).toEqual([
    { by: "orlevi", changes: ["skill tdd updated aaaaaaa → bbbbbbb"] },
  ]);
  expect(w.notices).toEqual([{ id: user.id, lines: ["skill tdd updated aaaaaaa → bbbbbbb"] }]);
  expect(w.restarts.map((r) => r.id)).toEqual([user.id]);
  expect(rtOther.appended).toEqual([]);
  expect(w.appendedToStore).toEqual([]);
});

test("a library change that resolves to what the process started with writes nothing and restarts nothing", async () => {
  const d = doc({ skills: ["tdd"] });
  const a = row();
  const w = world({ agents: [a] });
  const rt = w.load(a, true);
  w.started.set(a.id, startedWith(d, { tdd: GH("a") }));
  w.fresh.set(a.id, { doc: d, library: { skills: { tdd: GH("a") }, plugins: {} } });
  await w.changes.libraryChanged({ skills: ["tdd"], by: "orlevi" });
  expect([rt.appended, w.notices, w.restarts]).toEqual([[], [], []]);
});

test("a library change with no running process for the agent leaves it to its next start", async () => {
  const a = row();
  const w = world({ agents: [a] });
  const rt = w.load(a, false);
  w.fresh.set(a.id, {
    doc: doc({ skills: ["tdd"] }),
    library: { skills: { tdd: GH("b") }, plugins: {} },
  });
  await w.changes.libraryChanged({ skills: ["tdd"], by: "orlevi" });
  expect([rt.appended, w.notices, w.restarts, w.appendedToStore]).toEqual([[], [], [], []]);
  expect(w.scans()).toBe(1);
});
