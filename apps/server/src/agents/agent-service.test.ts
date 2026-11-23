import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FIELD_MSG } from "../field-messages.ts";
import { ContainerManager } from "../runtime/docker/containers.ts";
import { makeTestApp } from "../test/helpers.ts";
import { resyncPendingDir } from "../workspace/paths.ts";
import type { AgentService } from "./agent-service.ts";
import type { AgentRuntimes } from "./runtimes.ts";
import { sendAs } from "./testing/runtime-harness.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let svc: AgentService;
let runtimes: AgentRuntimes;
let home: string;

const yaml = (name: string, extra = "") =>
  `name: ${name}\ndisplay_name: ${name}\nruntime: local\nprojects:\n  - app\n${extra}`;
function writeTemplate(name: string, y: string) {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "template.yaml"), y);
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
}
const idOf = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r.id;
};

beforeAll(async () => {
  const fake = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_FAIL: "bad@mk" },
  });
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  home = t.factoryHome;
  svc = t.app.agents;
  runtimes = t.app.runtimes;
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  await t.db.insert(schema.projects).values({ id: randomUUID(), name: "app", hostPath: repo });
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  writeTemplate("lead", yaml("lead"));
  writeTemplate("plugged", yaml("plugged", "plugins:\n  - bad@mk\n"));
  writeFileSync(
    path.join(home, "templates/plugged/settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/mk" } } },
    }),
  );
  writeTemplate("broken", "name: broken\nruntime: nonsense\n");
});
afterAll(() => t.close());

test("create: layout on disk, rows, grants default; then summary in tree order", async () => {
  const a = await svc.create({
    template: "lead",
    slug: "lead",
    displayName: "Lead",
    description: "",
    reportsTo: null,
    credential: "work",
  });
  expect(a).toMatchObject({
    slug: "lead",
    template: "lead",
    runtime: "local",
    credential: "work",
    projects: ["app"],
    grantsOverridden: false,
    depth: 0,
    archivedAt: null,
  });
  expect(existsSync(path.join(home, "agents/lead/AGENTS.md"))).toBe(true);
  const b = await svc.create({
    template: "lead",
    slug: "dev-1",
    displayName: "Dev",
    description: "",
    reportsTo: "lead",
    credential: "work",
    projects: [],
  });
  expect(b).toMatchObject({ projects: [], grantsOverridden: true, depth: 1 });
  expect((await svc.list("exclude")).agents.map((x) => x.slug)).toEqual(["lead", "dev-1"]);
});

test("summaries carry the template avatarVersion", async () => {
  const avatar = path.join(home, "templates/lead/avatar.svg");
  const versions = async () =>
    (await svc.list("exclude")).agents
      .filter((a) => a.template === "lead")
      .map((a) => a.avatarVersion);
  expect(await versions()).toEqual([null, null]);
  writeFileSync(avatar, "<svg/>");
  const [v, w] = await versions();
  expect(v).toMatch(/^\d+-6$/);
  expect(w).toBe(v);
  expect((await svc.summary("dev-1")).avatarVersion).toBe(v);
  rmSync(avatar);
  symlinkSync(path.join(home, "templates/lead/AGENTS.md"), avatar);
  expect(await versions()).toEqual([null, null]);
  rmSync(avatar);
  expect(await versions()).toEqual([null, null]);
  expect((await svc.summary("lead")).avatarVersion).toBeNull();
});

test.each([
  ["slug taken", { slug: "lead" }, { code: "slug_taken" }],
  ["reserved slug", { slug: "humans" }, { code: "validation_error" }],
  [
    "unknown credential",
    { credential: "nope" },
    { code: "validation_error", extra: { fields: { credential: expect.any(String) } } },
  ],
  [
    "unknown project",
    { projects: ["web"] },
    { code: "validation_error", extra: { fields: { projects: expect.any(String) } } },
  ],
  ["unknown manager", { reportsTo: "ghost" }, { code: "validation_error" }],
  ["invalid template", { template: "broken" }, { code: "template_invalid" }],
])("create rejects: %s", async (_n, patch, err) => {
  await expect(
    svc.create({
      template: "lead",
      slug: "x-new",
      displayName: "X",
      description: "",
      reportsTo: null,
      credential: "work",
      ...patch,
    }),
  ).rejects.toMatchObject(err);
});

test("create race on one slug: one wins, the loser leaves the winner's folder intact", async () => {
  const body = {
    template: "lead",
    slug: "racer",
    displayName: "R",
    description: "",
    reportsTo: null,
    credential: "work",
  };
  const r = await Promise.allSettled([svc.create(body), svc.create(body)]);
  expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(existsSync(path.join(home, "agents/racer/AGENTS.md"))).toBe(true);
});

test("create: plugin failure removes the folder and inserts no row; existing folder → folder_exists, untouched", async () => {
  await expect(
    svc.create({
      template: "plugged",
      slug: "plug",
      displayName: "P",
      description: "",
      reportsTo: null,
      credential: "work",
    }),
  ).rejects.toMatchObject({ code: "plugin_install_failed" });
  expect(existsSync(path.join(home, "agents/plug"))).toBe(false);
  for (const ended of ["exclude", "only"] as const)
    expect((await svc.list(ended)).agents.map((a) => a.slug)).not.toContain("plug");
  mkdirSync(path.join(home, "agents/occupied"), { recursive: true });
  writeFileSync(path.join(home, "agents/occupied/keep.txt"), "k");
  await expect(
    svc.create({
      template: "lead",
      slug: "occupied",
      displayName: "O",
      description: "",
      reportsTo: null,
      credential: "work",
    }),
  ).rejects.toMatchObject({ code: "folder_exists" });
  expect(existsSync(path.join(home, "agents/occupied/keep.txt"))).toBe(true);
});

test("update: cycle rejected; projects null resets", async () => {
  await expect(svc.update("lead", { reportsTo: "dev-1" })).rejects.toMatchObject({
    message: FIELD_MSG.reportsCycle,
  });
  await svc.update("dev-1", { projects: null });
  expect((await svc.summary("dev-1")).grantsOverridden).toBe(false);
});

test("update: a rename restarts the agent and exactly its direct reports", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    await svc.update("lead", { displayName: "Lead 2" });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(
      [await idOf("lead"), await idOf("dev-1")].sort(),
    );
    spy.mockClear();
    // A feed-only change (grants) restarts the agent itself and leaves its reports alone.
    await svc.update("lead", { projects: [] });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([await idOf("lead")]);
    await svc.update("lead", { projects: null });
  } finally {
    spy.mockRestore();
  }
});

test("projects: duplicate names are deduped (order kept) on create and PATCH", async () => {
  const made = await svc.create({
    template: "lead",
    slug: "dupe",
    displayName: "D",
    description: "",
    reportsTo: null,
    credential: "work",
    projects: ["app", "app"],
  });
  expect(made.projects).toEqual(["app"]);
  await svc.update("dupe", { projects: [] });
  expect((await svc.update("dupe", { projects: ["app", "app"] })).projects).toEqual(["app"]);
});

test("resync: backup dir, runtime column, grants follow unless overridden; refused when archived", async () => {
  writeFileSync(path.join(home, "agents/lead/AGENTS.md"), "edited");
  writeFileSync(
    path.join(home, "templates/lead/template.yaml"),
    "name: lead\ndisplay_name: Lead\nruntime: local\nprojects: []\n",
  );
  const r = await svc.resync("lead");
  expect(r.backupDir).toMatch(/^state\/agents\/lead\/resync\//);
  expect(r.agent.projects).toEqual([]);
});

async function makeStageAgent(slug: string) {
  writeTemplate(slug, yaml(slug));
  await svc.create({
    template: slug,
    slug,
    displayName: slug,
    description: "",
    reportsTo: null,
    credential: "work",
  });
}
async function startAndStop(slug: string, start: boolean) {
  const rt = await runtimes.bySlug(slug);
  if (!rt) throw new Error("no runtime");
  if (start) {
    const u = await t.signUpUser();
    await sendAs(t.app.store, rt, {
      fromUserId: u.user.id,
      fromHandle: u.user.handle,
      body: "hi",
      urgent: false,
    });
    await vi.waitFor(() => expect(rt.hasProcess()).toBe(true));
  } else await rt.stop({ graceMs: 3000, termWaitMs: 10_000 });
  return rt;
}

test("re-sync of a running agent stages files and applies them at the next prepare", async () => {
  await makeStageAgent("stage-a");
  const wd = path.join(home, "agents/stage-a");
  const agentsMd = path.join(wd, "AGENTS.md");
  const OLD = readFileSync(agentsMd, "utf8");
  await startAndStop("stage-a", true);
  writeFileSync(path.join(home, "templates/stage-a/AGENTS.md"), "# NEW\n");
  const r = await svc.resync("stage-a");
  expect(r.applied).toBe("on_restart");
  expect(r.backupDir).toBeUndefined();
  expect(readFileSync(agentsMd, "utf8")).toBe(OLD);
  expect(readFileSync(path.join(resyncPendingDir(home, "stage-a"), "AGENTS.md"), "utf8")).toBe(
    "# NEW\n",
  );
  // the template copy in state/ is written at once
  expect(existsSync(path.join(home, "state/agents/stage-a/template/settings.json"))).toBe(true);
  await startAndStop("stage-a", false);
  await startAndStop("stage-a", true);
  expect(readFileSync(agentsMd, "utf8")).toBe("# NEW\n");
  expect(existsSync(resyncPendingDir(home, "stage-a"))).toBe(false);
  expect(
    readFileSync(
      path.join(
        home,
        "state/agents/stage-a/resync",
        readdirSync(path.join(home, "state/agents/stage-a/resync"))[0] ?? "",
        "AGENTS.md",
      ),
      "utf8",
    ),
  ).toBe(OLD);
  await startAndStop("stage-a", false);
});

test("re-sync of a hibernated agent applies at once", async () => {
  await makeStageAgent("stage-b");
  writeFileSync(path.join(home, "templates/stage-b/AGENTS.md"), "# NEW\n");
  const r = await svc.resync("stage-b");
  expect(r.applied).toBe("now");
  expect(readFileSync(path.join(home, "agents/stage-b/AGENTS.md"), "utf8")).toBe("# NEW\n");
  expect(existsSync(resyncPendingDir(home, "stage-b"))).toBe(false);
});

test("re-sync of a Docker agent stages while its container runs, or when Docker can't tell", async () => {
  writeTemplate("dock-a", yaml("dock-a").replace("runtime: local", "runtime: docker"));
  await svc.create({
    template: "dock-a",
    slug: "dock-a",
    displayName: "Dock",
    description: "",
    reportsTo: null,
    credential: "work",
  });
  const running = vi.spyOn(ContainerManager.prototype, "isRunning");
  try {
    running.mockResolvedValue(true);
    expect((await svc.resync("dock-a")).applied).toBe("on_restart");
    expect(running).toHaveBeenCalledWith(await idOf("dock-a"), "dock-a");
    running.mockRejectedValue(new Error("connect ECONNREFUSED /var/run/docker.sock"));
    expect((await svc.resync("dock-a")).applied).toBe("on_restart");
    running.mockResolvedValue(false);
    expect((await svc.resync("dock-a")).applied).toBe("now");
  } finally {
    running.mockRestore();
  }
});

test("a second staged re-sync replaces the pending dir", async () => {
  await makeStageAgent("stage-c");
  await startAndStop("stage-c", true);
  // Keep the process running across both re-syncs: the first one's apply-restart would otherwise stop it, and
  // whether that exit lands before the second re-sync decides is a race with the fake's exit (not under test).
  const restart = vi.spyOn(runtimes, "requestRestart").mockResolvedValue(undefined);
  try {
    const tplMd = path.join(home, "templates/stage-c/AGENTS.md");
    writeFileSync(tplMd, "# ONE\n");
    writeFileSync(path.join(home, "templates/stage-c/extra.txt"), "x");
    mkdirSync(path.join(home, "templates/stage-c/files"), { recursive: true });
    writeFileSync(path.join(home, "templates/stage-c/files/only-first.txt"), "1");
    expect((await svc.resync("stage-c")).applied).toBe("on_restart");
    rmSync(path.join(home, "templates/stage-c/files"), { recursive: true });
    writeFileSync(tplMd, "# TWO\n");
    expect((await svc.resync("stage-c")).applied).toBe("on_restart");
  } finally {
    restart.mockRestore();
  }
  const pending = resyncPendingDir(home, "stage-c");
  expect(readFileSync(path.join(pending, "AGENTS.md"), "utf8")).toBe("# TWO\n");
  expect(existsSync(path.join(pending, "only-first.txt"))).toBe(false);
  await startAndStop("stage-c", false);
});

test("a staged relative symlink from the template is applied as a link", async () => {
  await makeStageAgent("stage-d");
  const filesDir = path.join(home, "templates/stage-d/files");
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(path.join(filesDir, "real.txt"), "r");
  symlinkSync("real.txt", path.join(filesDir, "alias.txt"));
  await startAndStop("stage-d", true);
  expect((await svc.resync("stage-d")).applied).toBe("on_restart");
  await startAndStop("stage-d", false);
  await startAndStop("stage-d", true);
  const alias = path.join(home, "agents/stage-d/alias.txt");
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readlinkSync(alias)).toBe("real.txt");
  expect(existsSync(resyncPendingDir(home, "stage-d"))).toBe(false);
  await startAndStop("stage-d", false);
});

test("hasProcess is true while a start waits in prepare, before the spawn", async () => {
  await makeStageAgent("stage-e");
  const rt = await runtimes.bySlug("stage-e");
  if (!rt) throw new Error("no runtime");
  expect(rt.hasProcess()).toBe(false);
  const u = await t.signUpUser();
  let send: Promise<unknown> = Promise.resolve();
  await t.app.workspace.lock.run("stage-e", async () => {
    send = sendAs(t.app.store, rt, {
      fromUserId: u.user.id,
      fromHandle: u.user.handle,
      body: "hi",
      urgent: false,
    });
    send.catch(() => {});
    // prepareStart is queued behind this lock: no process yet, but a resync here must stage.
    await vi.waitFor(() => expect(rt.hasProcess()).toBe(true));
  });
  await send;
  await startAndStop("stage-e", false);
  expect(rt.hasProcess()).toBe(false);
});

test("a failing apply keeps resync-pending/ staged", async () => {
  await makeStageAgent("stage-f");
  const filesDir = path.join(home, "templates/stage-f/files/sub");
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(path.join(filesDir, "x.txt"), "x");
  await startAndStop("stage-f", true);
  await svc.resync("stage-f");
  await startAndStop("stage-f", false);
  // the agent planted a link where the factory expects a folder: SafeFs refuses the apply
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  symlinkSync(outside, path.join(home, "agents/stage-f/sub"));
  const rt = await runtimes.bySlug("stage-f");
  const u = await t.signUpUser();
  await expect(
    sendAs(t.app.store, rt, {
      fromUserId: u.user.id,
      fromHandle: u.user.handle,
      body: "hi",
      urgent: false,
    }),
  ).rejects.toBeDefined();
  expect(existsSync(path.join(resyncPendingDir(home, "stage-f"), "sub/x.txt"))).toBe(true);
  expect(existsSync(path.join(outside, "x.txt"))).toBe(false);
});

test("archive is blocked while active reports exist", async () => {
  await expect(svc.archive("lead")).rejects.toMatchObject({
    code: "has_reports",
    message: "@dev-1 reports to this agent. Change their manager first.",
  });
});

test("archive hides, refuses re-sync, allows PATCH; unarchive restores", async () => {
  await svc.archive("dev-1");
  expect((await svc.list("only")).agents.map((a) => a.slug)).toEqual(["dev-1"]);
  expect((await svc.list("exclude")).agents.map((a) => a.slug)).not.toContain("dev-1");
  await expect(svc.resync("dev-1")).rejects.toMatchObject({ code: "agent_archived" });
  expect((await svc.update("dev-1", { description: "parked" })).description).toBe("parked");
  expect((await svc.unarchive("dev-1")).archivedAt).toBeNull();
});

test("unarchive is refused while the manager is archived", async () => {
  await svc.update("dev-1", { reportsTo: null });
  await svc.create({
    template: "lead",
    slug: "helper",
    displayName: "Helper",
    description: "",
    reportsTo: "dev-1",
    credential: "work",
  });
  await svc.archive("helper");
  await svc.archive("dev-1");
  await expect(svc.unarchive("helper")).rejects.toMatchObject({
    code: "manager_archived",
    message: "Its manager @dev-1 is archived. Change its manager first.",
  });
});

test("create refuses a slug that is a human handle", async () => {
  await t.signUpUser({ handle: "sam" });
  await expect(
    svc.create({
      template: "lead",
      slug: "sam",
      displayName: "Sam",
      description: "",
      reportsTo: null,
      credential: "work",
    }),
  ).rejects.toMatchObject({ code: "slug_taken" });
});

async function createSpawner(slug: string) {
  await svc.create({
    template: "lead",
    slug,
    displayName: slug,
    description: "",
    reportsTo: null,
    credential: "work",
  });
  return idOf(slug);
}
/** A spawned child of `spawnerId`, inserted with `q` (a test transaction or the pool). */
const insertChild = (
  q: typeof t.sql,
  spawnerId: string,
  slug: string,
  terminated = false,
) => q`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
       select ${randomUUID()}, ${slug}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id,
              ${terminated ? new Date().toISOString() : null}::timestamptz, ${terminated ? "@factory" : null}
       from agents where id = ${spawnerId}`;

/**
 * Resolves once `n` archives are waiting on the row lock `holder` holds: their own `for no key update` query, in a
 * `Lock` wait, on another backend. Each check is a DB round trip; only the test's own timeout bounds it.
 */
async function archivesWaiting(holder: number, n: number) {
  for (;;) {
    const [w] = await t.sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> ${holder} and wait_event_type = 'Lock'
        and query ilike '%for no key update%'`;
    if ((w?.n ?? 0) >= n) return;
  }
}

/** A transaction holding `id`'s row lock until `release()`, running `then` before it commits. */
function holdRowLock(id: string, then: (tx: typeof t.sql) => Promise<unknown> = async () => {}) {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let pid!: (n: number) => void;
  const holder = new Promise<number>((r) => {
    pid = r;
  });
  const done = t.sql.begin(async (tx) => {
    const [me] = await tx`select pg_backend_pid() as pid`;
    await tx`select id from agents where id = ${id} for no key update`;
    pid(me?.pid as number);
    await released;
    await then(tx as unknown as typeof t.sql);
  });
  return { holder, release, done };
}

test("archive takes the spawner's row lock first, then counts live reports in that transaction (spec §5.7)", async () => {
  const id = await createSpawner("spawner");
  // A spawn's transaction stand-in: holds the row lock, inserts a live child, commits when released.
  const lock = holdRowLock(id, (tx) => insertChild(tx, id, "spawner-ab12"));
  const holder = await lock.holder;
  const archive = svc.archive("spawner").then(
    () => "archived",
    (e: unknown) => e,
  );
  await archivesWaiting(holder, 1);
  lock.release();
  await lock.done;
  expect(await archive).toMatchObject({
    code: "has_reports",
    message: "@spawner has live spawned agents: @spawner-ab12. Terminate them first.",
    extra: { reports: ["spawner-ab12"] },
  });
  expect((await t.sql`select archived_at from agents where id = ${id}`)[0]?.archived_at).toBeNull();
});

test("two concurrent archives: the second sees the first's commit under the lock and writes no peer events", async () => {
  const id = await createSpawner("twice");
  const lock = holdRowLock(id);
  const holder = await lock.holder;
  const both = Promise.all([svc.archive("twice"), svc.archive("twice")]);
  await archivesWaiting(holder, 2);
  lock.release();
  await lock.done;
  for (const a of await both) expect(a.archivedAt).not.toBeNull();
  const rows =
    await t.sql`select to_agent_id from messages where subject_agent_id = ${id} and kind = 'peer_left'`;
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((r) => r.to_agent_id)).size).toBe(rows.length);
});

test("archive counts only live reports: a terminated spawned agent doesn't block it", async () => {
  const id = await createSpawner("spawner-2");
  await insertChild(t.sql, id, "spawner-2-cd34", true);
  expect((await svc.archive("spawner-2")).archivedAt).not.toBeNull();
});

test("archive names every live spawned agent", async () => {
  const id = await createSpawner("spawner-3");
  await insertChild(t.sql, id, "spawner-3-bb22");
  await insertChild(t.sql, id, "spawner-3-aa11");
  await expect(svc.archive("spawner-3")).rejects.toMatchObject({
    code: "has_reports",
    message:
      "@spawner-3 has live spawned agents: @spawner-3-aa11, @spawner-3-bb22. Terminate them first.",
    extra: { reports: ["spawner-3-aa11", "spawner-3-bb22"] },
  });
});

test("a spawned agent can't be edited, re-synced, archived or unarchived: 409 ephemeral_agent", async () => {
  const id = await createSpawner("spawner-4");
  await insertChild(t.sql, id, "spawner-4-ee11");
  const refused = {
    status: 409,
    code: "ephemeral_agent",
    message: "Spawned agents can't be edited; terminate it instead.",
  };
  await expect(svc.update("spawner-4-ee11", { displayName: "X" })).rejects.toMatchObject(refused);
  await expect(svc.resync("spawner-4-ee11")).rejects.toMatchObject(refused);
  await expect(svc.archive("spawner-4-ee11")).rejects.toMatchObject(refused);
  await expect(svc.unarchive("spawner-4-ee11")).rejects.toMatchObject(refused);
  const { cookie } = await t.signUpUser();
  const res = await t.app.inject({
    method: "PATCH",
    url: "/api/agents/spawner-4-ee11",
    headers: { cookie },
    payload: { displayName: "X" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: { code: "ephemeral_agent" } });
  const [r] = await t.sql`select display_name from agents where slug = 'spawner-4-ee11'`;
  expect(r?.display_name).toBe("Kid");
});

test("a spawned agent can't be a manager on create or edit", async () => {
  const id = await createSpawner("spawner-5");
  await insertChild(t.sql, id, "spawner-5-ff11");
  const field = {
    message: "Choose an active agent.",
    extra: { fields: { reportsTo: "Choose an active agent." } },
  };
  await expect(
    svc.create({
      template: "lead",
      slug: "under-kid",
      displayName: "Under",
      description: "",
      reportsTo: "spawner-5-ff11",
      credential: "work",
    }),
  ).rejects.toMatchObject(field);
  await expect(svc.update("spawner-5", { reportsTo: "spawner-5-ff11" })).rejects.toMatchObject(
    field,
  );
  await createSpawner("spawner-6");
  await expect(svc.update("spawner-6", { reportsTo: "spawner-5-ff11" })).rejects.toMatchObject(
    field,
  );
});

test("renaming a spawner restarts its live spawned agents, never a terminated one", async () => {
  const id = await createSpawner("spawner-7");
  await insertChild(t.sql, id, "spawner-7-aa11");
  await insertChild(t.sql, id, "spawner-7-dd44", true);
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    await svc.update("spawner-7", { displayName: "Seven" });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(
      [id, await idOf("spawner-7-aa11")].sort(),
    );
  } finally {
    spy.mockRestore();
  }
  expect(await runtimes.get(await idOf("spawner-7-dd44"))).toBeUndefined();
});
