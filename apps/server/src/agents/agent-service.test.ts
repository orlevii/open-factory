import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { refOf } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { FIELD_MSG } from "../field-messages.ts";
import { agentRecords, principalById, principalsByHandles } from "../principals/principal-store.ts";
import { ContainerManager } from "../runtime/docker/containers.ts";
import { makeTestApp } from "../test/helpers.ts";
import { principalSql, seedTestPrincipal, seedTestUser } from "../test/principals.ts";
import type { AgentService } from "./agent-service.ts";
import type { AgentRuntimes } from "./runtimes.ts";
import { sendAs } from "./testing/runtime-harness.ts";

let fake: ReturnType<typeof createFakeClaude>;
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
const idOf = async (handle: string) => {
  const [r] = await agentRecords(t.db).where(eq(schema.principals.handle, handle));
  if (!r) throw new Error(`no agent ${handle}`);
  return r.id;
};

const refFor = async (handle: string) => refOf(await idOf(handle));
const workdirOf = async (handle: string) => path.join(home, "agents", await refFor(handle));
const stateOf = async (handle: string) => path.join(home, "state", "agents", await refFor(handle));

beforeAll(async () => {
  fake = createFakeClaude({ scenario: "reply" });
  t = await makeTestApp({ env: { FACTORY_CLAUDE_BIN: fake.bin } });
  home = t.factoryHome;
  await seedTestUser(t.db, "or");
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
  writeTemplate("broken", "name: broken\nruntime: nonsense\n");
});
afterAll(() => t.close());

test("create: layout on disk, rows, grants default; then summary in tree order", async () => {
  const a = await svc.create(
    {
      template: "lead",
      handle: "lead",
      displayName: "Lead",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  expect(a).toMatchObject({
    ref: await refFor("lead"),
    handle: "lead",
    template: "lead",
    runtime: "local",
    credential: "work",
    projects: ["app"],
    depth: 0,
    archivedAt: null,
  });
  expect(existsSync(path.join(await workdirOf("lead"), "AGENTS.md"))).toBe(true);
  expect(existsSync(path.join(home, "agents", "lead"))).toBe(false);
  const b = await svc.create(
    {
      template: "lead",
      handle: "dev-1",
      displayName: "Dev",
      description: "",
      reportsTo: "lead",
      credential: "work",
      projects: [],
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  expect(b).toMatchObject({ projects: [], depth: 1 });
  expect((await svc.list("exclude")).agents.map((x) => x.handle)).toEqual(["lead", "dev-1"]);
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
  expect((await svc.summary(await refFor("dev-1"))).avatarVersion).toBe(v);
  rmSync(avatar);
  symlinkSync(path.join(home, "templates/lead/AGENTS.md"), avatar);
  expect(await versions()).toEqual([null, null]);
  rmSync(avatar);
  expect(await versions()).toEqual([null, null]);
  expect((await svc.summary(await refFor("lead"))).avatarVersion).toBeNull();
});

test.each([
  ["handle taken", { handle: "lead" }, { code: "handle_taken" }],
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
    svc.create(
      {
        template: "lead",
        handle: "x-new",
        displayName: "X",
        description: "",
        reportsTo: "or",
        credential: "work",
        ...patch,
      },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(err);
});

test("create with a reserved handle is refused and creates no principal", async () => {
  const handles = ["humans", "me", "scheduler"];
  for (const handle of handles)
    await expect(
      svc.create(
        {
          template: "lead",
          handle,
          displayName: "X",
          description: "",
          reportsTo: "or",
          credential: "work",
        },
        { kind: "human", ref: "k7x2m9qd", handle: "or" },
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  expect((await principalsByHandles(t.db, handles)).size).toBe(0);
});

test("create: a folder that carries the handle's name is no collision and stays untouched", async () => {
  const named = path.join(home, "agents", "occupied");
  mkdirSync(named, { recursive: true });
  writeFileSync(path.join(named, "keep.txt"), "k");
  await svc.create(
    {
      template: "lead",
      handle: "occupied",
      displayName: "O",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  expect(existsSync(path.join(named, "keep.txt"))).toBe(true);
  expect(existsSync(path.join(await workdirOf("occupied"), "AGENTS.md"))).toBe(true);
});

test("update: cycle rejected", async () => {
  await expect(
    svc.update(
      await refFor("lead"),
      { reportsTo: "dev-1" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject({
    message: FIELD_MSG.reportsCycle,
  });
});

test("update: a rename restarts the agent and exactly its direct reports", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    await svc.update(
      await refFor("lead"),
      { displayName: "Lead 2" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(
      [await idOf("lead"), await idOf("dev-1")].sort(),
    );
    spy.mockClear();
    // A feed-only change (grants) restarts the agent itself and leaves its reports alone.
    await svc.update(
      await refFor("lead"),
      { projects: [] },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
    expect(spy.mock.calls.map((c) => c[0])).toEqual([await idOf("lead")]);
    await svc.update(
      await refFor("lead"),
      { projects: ["app"] },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
  } finally {
    spy.mockRestore();
  }
});

test("update: a colour-only change never restarts, shows in the summary, and null returns to Auto", async () => {
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    expect(
      (
        await svc.update(
          await refFor("lead"),
          { color: 7 },
          { kind: "human", ref: "k7x2m9qd", handle: "or" },
        )
      ).color,
    ).toBe(7);
    expect((await svc.summary(await refFor("lead"))).color).toBe(7);
    expect(
      (
        await svc.update(
          await refFor("lead"),
          { color: null },
          { kind: "human", ref: "k7x2m9qd", handle: "or" },
        )
      ).color,
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("the agents_color CHECK rejects 13 and 0 on its own row", async () => {
  await svc.create(
    {
      template: "lead",
      handle: "colour-check",
      displayName: "C",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  for (const bad of [13, 0])
    await expect(
      t.sql`update agents set color = ${bad} where id = (select id from principals where handle = 'colour-check')`,
    ).rejects.toThrow(/agents_color|check/i);
});

test("projects: duplicate names are deduped (order kept) on create and PATCH", async () => {
  const made = await svc.create(
    {
      template: "lead",
      handle: "dupe",
      displayName: "D",
      description: "",
      reportsTo: "or",
      credential: "work",
      projects: ["app", "app"],
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  expect(made.projects).toEqual(["app"]);
  await svc.update(
    await refFor("dupe"),
    { projects: [] },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  expect(
    (
      await svc.update(
        await refFor("dupe"),
        { projects: ["app", "app"] },
        { kind: "human", ref: "k7x2m9qd", handle: "or" },
      )
    ).projects,
  ).toEqual(["app"]);
});

async function makeStageAgent(handle: string) {
  writeTemplate(handle, yaml(handle));
  await svc.create(
    {
      template: handle,
      handle,
      displayName: handle,
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
}
async function startAndStop(handle: string, start: boolean) {
  const rt = await runtimes.byRef(await t.refOf(handle));
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

/** The pending `config_changed` notice lines of an agent. */
async function pendingConfigLines(handle: string): Promise<string[]> {
  const rows = await t.sql`
    select body from messages where to_id = ${await idOf(handle)} and notice = 'config_changed' and state = 'pending'`;
  return rows.flatMap((r) =>
    String(r.body)
      .split("\n")
      .filter((l) => l.startsWith("- ")),
  );
}
const personaBackups = async (handle: string) => {
  const dir = path.join(await stateOf(handle), "persona");
  return existsSync(dir) ? readdirSync(dir) : [];
};

test("reset persona of a hibernated agent applies at once, saves the old file and records the notice line", async () => {
  await makeStageAgent("persona-a");
  const agentsMd = path.join(await workdirOf("persona-a"), "AGENTS.md");
  writeFileSync(agentsMd, "edited");
  const restart = vi.spyOn(runtimes, "requestRestart");
  try {
    const r = await svc.resetPersona(await refFor("persona-a"), "@or");
    expect(r.applied).toBe("now");
    expect(r.backupDir).toMatch(
      new RegExp(`^state/agents/${await refFor("persona-a")}/persona/\\d{4}-`),
    );
    expect(readFileSync(agentsMd, "utf8")).toBe("# persona-a\n");
    expect(readFileSync(path.join(home, r.backupDir ?? "", "AGENTS.md"), "utf8")).toBe("edited");
    await vi.waitFor(async () =>
      expect(await pendingConfigLines("persona-a")).toEqual([
        "- AGENTS.md reset from template persona-a; the previous file is saved.",
      ]),
    );
    expect(restart).not.toHaveBeenCalled();
    // Nothing differs now: no second backup, no change.
    expect(await svc.resetPersona(await refFor("persona-a"), "@or")).toEqual({ applied: "now" });
    expect(await personaBackups("persona-a")).toHaveLength(1);
  } finally {
    restart.mockRestore();
  }
});

test("reset persona of a running agent stages the file, asks for a restart and applies at the next prepare", async () => {
  await makeStageAgent("persona-b");
  const agentsMd = path.join(await workdirOf("persona-b"), "AGENTS.md");
  const OLD = readFileSync(agentsMd, "utf8");
  await startAndStop("persona-b", true);
  writeFileSync(path.join(home, "templates/persona-b/AGENTS.md"), "# NEW\n");
  // Keep the process running: the restart request would otherwise stop it before the assertions.
  const restart = vi.spyOn(runtimes, "requestRestart").mockResolvedValue(undefined);
  try {
    const r = await svc.resetPersona(await refFor("persona-b"), "@or");
    expect(r).toEqual({ applied: "on_restart" });
    expect(readFileSync(agentsMd, "utf8")).toBe(OLD);
    expect(
      readFileSync(path.join(await stateOf("persona-b"), "persona-pending/AGENTS.md"), "utf8"),
    ).toBe("# NEW\n");
    const id = await idOf("persona-b");
    await vi.waitFor(() =>
      expect(restart).toHaveBeenCalledWith(id, { changes: ["persona reset from template"] }),
    );
  } finally {
    restart.mockRestore();
  }
  await startAndStop("persona-b", false);
  await startAndStop("persona-b", true);
  expect(readFileSync(agentsMd, "utf8")).toBe("# NEW\n");
  expect(existsSync(path.join(await stateOf("persona-b"), "persona-pending"))).toBe(false);
  const [stamp] = await personaBackups("persona-b");
  expect(
    readFileSync(
      path.join(await stateOf("persona-b"), "persona", stamp ?? "", "AGENTS.md"),
      "utf8",
    ),
  ).toBe(OLD);
  await startAndStop("persona-b", false);
});

test("reset persona of a Docker agent stages while its container runs, or when Docker can't tell", async () => {
  writeTemplate("dock-p", yaml("dock-p").replace("runtime: local", "runtime: docker"));
  await svc.create(
    {
      template: "dock-p",
      handle: "dock-p",
      displayName: "Dock",
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  const running = vi.spyOn(ContainerManager.prototype, "isRunning");
  try {
    running.mockResolvedValue(true);
    expect((await svc.resetPersona(await refFor("dock-p"), "@or")).applied).toBe("on_restart");
    expect(running).toHaveBeenCalledWith(await idOf("dock-p"), await refFor("dock-p"));
    running.mockRejectedValue(new Error("connect ECONNREFUSED /var/run/docker.sock"));
    expect((await svc.resetPersona(await refFor("dock-p"), "@or")).applied).toBe("on_restart");
    running.mockResolvedValue(false);
    expect((await svc.resetPersona(await refFor("dock-p"), "@or")).applied).toBe("now");
  } finally {
    running.mockRestore();
  }
});

test("reset persona: an archived agent is allowed (no notice), a broken or AGENTS.md-less template is 409", async () => {
  await makeStageAgent("persona-c");
  writeFileSync(path.join(await workdirOf("persona-c"), "AGENTS.md"), "edited");
  await svc.archive(await refFor("persona-c"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  expect((await svc.resetPersona(await refFor("persona-c"), "@or")).applied).toBe("now");
  expect(readFileSync(path.join(await workdirOf("persona-c"), "AGENTS.md"), "utf8")).toBe(
    "# persona-c\n",
  );
  expect(await pendingConfigLines("persona-c")).toEqual([]);
  // Unarchived again so the archived list stays the later archive tests' own.
  await svc.unarchive(await refFor("persona-c"), { kind: "human", ref: "k7x2m9qd", handle: "or" });

  rmSync(path.join(home, "templates/persona-c/AGENTS.md"));
  await expect(svc.resetPersona(await refFor("persona-c"), "@or")).rejects.toMatchObject({
    status: 409,
    code: "template_invalid",
  });
  writeFileSync(
    path.join(home, "templates/persona-c/template.yaml"),
    "name: persona-c\nruntime: nonsense\n",
  );
  await expect(svc.resetPersona(await refFor("persona-c"), "@or")).rejects.toMatchObject({
    code: "template_invalid",
  });
  rmSync(path.join(home, "templates/persona-c"), { recursive: true });
  await expect(svc.resetPersona(await refFor("persona-c"), "@or")).rejects.toMatchObject({
    code: "template_missing",
  });
});

test("reset persona: a symlinked template AGENTS.md is refused, and an unloaded agent still gets the event", async () => {
  await makeStageAgent("persona-e");
  writeFileSync(path.join(await workdirOf("persona-e"), "AGENTS.md"), "edited");
  const real = path.join(home, "templates/persona-e/real.md");
  writeFileSync(real, "# linked\n");
  rmSync(path.join(home, "templates/persona-e/AGENTS.md"));
  symlinkSync(real, path.join(home, "templates/persona-e/AGENTS.md"));
  await expect(svc.resetPersona(await refFor("persona-e"), "@or")).rejects.toMatchObject({
    status: 409,
    code: "template_invalid",
  });
  rmSync(path.join(home, "templates/persona-e/AGENTS.md"));
  writeFileSync(path.join(home, "templates/persona-e/AGENTS.md"), "# NEW\n");
  await svc.resetPersona(await refFor("persona-e"), "@or");
  const id = await idOf("persona-e");
  await vi.waitFor(async () => {
    const ev =
      await t.sql`select payload from session_events where agent_id = ${id} and type = 'config_changed'`;
    expect(ev.map((e) => e.payload)).toEqual([
      expect.objectContaining({ by: "@or", changes: ["AGENTS.md reset from template persona-e"] }),
    ]);
  });
});

test("reset persona: a recreated (missing) AGENTS.md records the notice without a saved-file claim", async () => {
  await makeStageAgent("persona-f");
  rmSync(path.join(await workdirOf("persona-f"), "AGENTS.md"));
  expect(await svc.resetPersona(await refFor("persona-f"), "@or")).toEqual({ applied: "now" });
  await vi.waitFor(async () =>
    expect(await pendingConfigLines("persona-f")).toEqual([
      "- AGENTS.md reset from template persona-f.",
    ]),
  );
});

test("reset persona refuses an agent whose workdir is a link, writing nothing through it", async () => {
  await makeStageAgent("persona-d");
  const wd = await workdirOf("persona-d");
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  rmSync(wd, { recursive: true });
  symlinkSync(outside, wd);
  await expect(svc.resetPersona(await refFor("persona-d"), "@or")).rejects.toMatchObject({
    status: 409,
    code: "workdir_unusable",
  });
  expect(existsSync(path.join(outside, "AGENTS.md"))).toBe(false);
});

test("hasProcess is true while a start waits in prepare, before the spawn", async () => {
  await makeStageAgent("stage-e");
  const rt = await runtimes.byRef(await t.refOf("stage-e"));
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
    // prepareStart is queued behind this lock: no process yet, but a reset here must stage.
    await vi.waitFor(() => expect(rt.hasProcess()).toBe(true));
  });
  await send;
  await startAndStop("stage-e", false);
  expect(rt.hasProcess()).toBe(false);
});

test("archive is blocked while active reports exist", async () => {
  await expect(
    svc.archive(await refFor("lead"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({
    code: "has_reports",
    message: "@dev-1 reports to this agent. Change their manager first.",
  });
});

test("archive hides and allows PATCH; unarchive restores", async () => {
  await svc.archive(await refFor("dev-1"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  expect((await svc.list("only")).agents.map((a) => a.handle)).toEqual(["dev-1"]);
  expect((await svc.list("exclude")).agents.map((a) => a.handle)).not.toContain("dev-1");
  expect(
    (
      await svc.update(
        await refFor("dev-1"),
        { description: "parked" },
        { kind: "human", ref: "k7x2m9qd", handle: "or" },
      )
    ).description,
  ).toBe("parked");
  expect(
    (await svc.unarchive(await refFor("dev-1"), { kind: "human", ref: "k7x2m9qd", handle: "or" }))
      .archivedAt,
  ).toBeNull();
});

test("unarchive is refused while the manager is archived", async () => {
  await svc.update(
    await refFor("dev-1"),
    { reportsTo: "or" },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  await svc.create(
    {
      template: "lead",
      handle: "helper",
      displayName: "Helper",
      description: "",
      reportsTo: "dev-1",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  await svc.archive(await refFor("helper"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  await svc.archive(await refFor("dev-1"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  await expect(
    svc.unarchive(await refFor("helper"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({
    code: "manager_archived",
    message: "Its manager @dev-1 is archived. Change its manager first.",
  });
});

test("create refuses a handle that is a human handle", async () => {
  await t.signUpUser({ handle: "sam" });
  await expect(
    svc.create(
      {
        template: "lead",
        handle: "sam",
        displayName: "Sam",
        description: "",
        reportsTo: "or",
        credential: "work",
      },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject({ code: "handle_taken" });
});

const createBody = (handle: string) => ({
  template: "lead",
  handle,
  displayName: handle,
  description: "",
  reportsTo: "or",
  credential: "work",
});
const agentRows = async (handle: string) =>
  agentRecords(t.db).where(eq(schema.principals.handle, handle));

test("create refuses a handle held by a human principal that has no user row yet", async () => {
  await seedTestPrincipal(t.db, "human", "inflight");
  const folders = readdirSync(path.join(home, "agents"));
  await expect(
    svc.create(createBody("inflight"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({ code: "handle_taken" });
  expect(await agentRows("inflight")).toEqual([]);
  expect(readdirSync(path.join(home, "agents"))).toEqual(folders);
});

test("creating an agent with a taken handle is refused on the handle field", async () => {
  await svc.create(createBody("twin-one"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  await expect(
    svc.create(createBody("twin-one"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({
    status: 409,
    code: "handle_taken",
    extra: { fields: { handle: expect.any(String) } },
  });
  expect(await agentRows("twin-one")).toHaveLength(1);
});

test("creating an agent creates its principal with the agent's id and handle", async () => {
  await svc.create(createBody("claimed-one"), { kind: "human", ref: "k7x2m9qd", handle: "or" });
  const [agent] = await agentRows("claimed-one");
  const principal = await principalById(t.db, agent?.id ?? "");
  expect(principal).toMatchObject({ kind: "agent", handle: "claimed-one" });
  expect(principal?.ref).toBe(refOf(agent?.id ?? ""));
});

test("two concurrent creates of one handle: one succeeds, the other is handle_taken, no duplicate, the winner's folder intact", async () => {
  const results = await Promise.allSettled([
    svc.create(createBody("dup-race"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
    svc.create(createBody("dup-race"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected");
  expect(failed).toMatchObject({ reason: { code: "handle_taken" } });
  expect(await agentRows("dup-race")).toHaveLength(1);
  expect(existsSync(path.join(await workdirOf("dup-race"), "AGENTS.md"))).toBe(true);
});

async function createSpawner(handle: string) {
  await svc.create(
    {
      template: "lead",
      handle,
      displayName: handle,
      description: "",
      reportsTo: "or",
      credential: "work",
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  return idOf(handle);
}
/**
 * A spawned child of `spawnerId`, inserted with `q` (a test transaction or the pool). Like a real spawn it holds the
 * spawner's grants (the shared template lists them all), so it starts in sync with its spawner.
 */
const insertChild = async (
  q: typeof t.sql,
  spawnerId: string,
  handle: string,
  terminated = false,
) => {
  const id = randomUUID();
  await q.unsafe(principalSql(id, "agent", handle));
  await q`insert into agents (id, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
       select ${id}, 'Kid', template, config, runtime, credential_id, 'ephemeral', id,
              ${terminated ? new Date().toISOString() : null}::timestamptz, null
       from agents where id = ${spawnerId}`;
  await q`insert into agent_project_grants (agent_id, project_id)
       select ${id}, project_id from agent_project_grants where agent_id = ${spawnerId}`;
};

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
  const archive = svc
    .archive(await refFor("spawner"), { kind: "human", ref: "k7x2m9qd", handle: "or" })
    .then(
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
  const both = Promise.all([
    svc.archive(await refFor("twice"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
    svc.archive(await refFor("twice"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ]);
  await archivesWaiting(holder, 2);
  lock.release();
  await lock.done;
  for (const a of await both) expect(a.archivedAt).not.toBeNull();
  const rows =
    await t.sql`select to_id from messages where subject_agent_id = ${id} and kind = 'peer_left'`;
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((r) => r.to_id)).size).toBe(rows.length);
});

test("archive counts only live reports: a terminated spawned agent doesn't block it", async () => {
  const id = await createSpawner("spawner-2");
  await insertChild(t.sql, id, "spawner-2-cd34", true);
  expect(
    (await svc.archive(await refFor("spawner-2"), { kind: "human", ref: "k7x2m9qd", handle: "or" }))
      .archivedAt,
  ).not.toBeNull();
});

test("archive names every live spawned agent", async () => {
  const id = await createSpawner("spawner-3");
  await insertChild(t.sql, id, "spawner-3-bb22");
  await insertChild(t.sql, id, "spawner-3-aa11");
  await expect(
    svc.archive(await refFor("spawner-3"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject({
    code: "has_reports",
    message:
      "@spawner-3 has live spawned agents: @spawner-3-aa11, @spawner-3-bb22. Terminate them first.",
    extra: { reports: ["spawner-3-aa11", "spawner-3-bb22"] },
  });
});

test("a spawned agent can't be edited, reset, archived or unarchived: 409 ephemeral_agent", async () => {
  const id = await createSpawner("spawner-4");
  await insertChild(t.sql, id, "spawner-4-ee11");
  const refused = {
    status: 409,
    code: "ephemeral_agent",
    message: "Spawned agents can't be edited; terminate it instead.",
  };
  await expect(
    svc.update(
      await refFor("spawner-4-ee11"),
      { displayName: "X" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(refused);
  await expect(
    svc.update(
      await refFor("spawner-4-ee11"),
      { color: 3 },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(refused);
  await expect(svc.resetPersona(await refFor("spawner-4-ee11"), "@or")).rejects.toMatchObject(
    refused,
  );
  await expect(
    svc.archive(await refFor("spawner-4-ee11"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject(refused);
  await expect(
    svc.unarchive(await refFor("spawner-4-ee11"), { kind: "human", ref: "k7x2m9qd", handle: "or" }),
  ).rejects.toMatchObject(refused);
  const [r] =
    await t.sql`select display_name from agents where id = (select id from principals where handle = 'spawner-4-ee11')`;
  expect(r?.display_name).toBe("Kid");
});

test("a spawned agent can't be a manager on create or edit", async () => {
  const id = await createSpawner("spawner-5");
  await insertChild(t.sql, id, "spawner-5-ff11");
  const field = {
    message: FIELD_MSG.chooseManager,
    extra: { fields: { reportsTo: FIELD_MSG.chooseManager } },
  };
  await expect(
    svc.create(
      {
        template: "lead",
        handle: "under-kid",
        displayName: "Under",
        description: "",
        reportsTo: "spawner-5-ff11",
        credential: "work",
      },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(field);
  await expect(
    svc.update(
      await refFor("spawner-5"),
      { reportsTo: "spawner-5-ff11" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(field);
  await createSpawner("spawner-6");
  await expect(
    svc.update(
      await refFor("spawner-6"),
      { reportsTo: "spawner-5-ff11" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    ),
  ).rejects.toMatchObject(field);
});

test("renaming a spawner restarts its live spawned agents, never a terminated one", async () => {
  const id = await createSpawner("spawner-7");
  await insertChild(t.sql, id, "spawner-7-aa11");
  await insertChild(t.sql, id, "spawner-7-dd44", true);
  const spy = vi.spyOn(runtimes, "requestRestart");
  try {
    await svc.update(
      await refFor("spawner-7"),
      { displayName: "Seven" },
      { kind: "human", ref: "k7x2m9qd", handle: "or" },
    );
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(
      [id, await idOf("spawner-7-aa11")].sort(),
    );
  } finally {
    spy.mockRestore();
  }
  expect(await runtimes.get(await idOf("spawner-7-dd44"))).toBeUndefined();
});

test("a human-managed agent reports its manager as a human", async () => {
  const created = await svc.create(
    {
      template: "lead",
      handle: "human-led",
      displayName: "Human led",
      description: "",
      reportsTo: "or",
      credential: "work",
      projects: [],
    },
    { kind: "human", ref: "k7x2m9qd", handle: "or" },
  );
  const or = (await principalsByHandles(t.db, ["or"])).get("or");
  expect(created.reportsTo).toEqual({ kind: "human", ref: or?.ref, handle: "or" });
  expect((await svc.summary(await refFor("human-led"))).reportsTo).toEqual({
    kind: "human",
    ref: or?.ref,
    handle: "or",
  });
});
