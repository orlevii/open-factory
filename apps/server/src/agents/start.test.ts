import {
  existsSync,
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
import { type AgentRow, schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type Config, loadConfig } from "../config.ts";
import { Vault } from "../crypto/vault.ts";
import { Neighborhood } from "../messaging/neighborhood.ts";
import { TemplateIndex } from "../templates/template-index.ts";
import { claimTestHandle } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import { Workspace } from "../workspace/workspace.ts";
import { ConfigResolver, type Effective } from "./config-resolver.ts";
import { AgentStartError, forSpawnedAgent } from "./errors.ts";
import { createPrepareStart, deriveInheritance, type StartPreparer } from "./start.ts";

const KEY = "k".repeat(40);
let t: Awaited<ReturnType<typeof createTestDb>>;
let home: string;
let repo: string;
let hs: string;
let workspace: Workspace;
let lock: KeyedMutex;
/** The real prepareStart with `loaded` bound, as `AgentRuntimes` binds it for every start. */
let prepareStart: StartPreparer;
let factoryConfig: Config;
let resolver: ConfigResolver;
/** Stands in for the runtimes' `started`: what a loaded spawner's process started with. */
const loaded = new Map<string, Effective>();
let agent: AgentRow;
let seq = 0;
const vault = new Vault(KEY);

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

/** template.yaml as JSON (valid YAML), in this fixture's factory home. */
function writeYaml(name: string, doc: Record<string, unknown>) {
  const dir = path.join(home, "templates", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "template.yaml"), JSON.stringify(doc));
}
const writeTemplateFile = (name: string, file: string, text: string) =>
  writeFileSync(path.join(home, "templates", name, file), text);

async function reload(id: string): Promise<AgentRow> {
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, id));
  if (!row) throw new Error("no agent");
  return row;
}

async function seedStartFixture() {
  seq += 1;
  await t.sql`delete from agent_project_grants`;
  await t.sql`delete from agents`;
  await t.sql`delete from templates`;
  loaded.clear();
  await t.sql`delete from credentials`;
  await t.sql`delete from secrets`;
  await t.sql`delete from projects`;
  home = mkdtempSync(path.join(tmpdir(), "of-start-"));
  hs = mkdtempSync(path.join(tmpdir(), "hs-"));
  repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  const slug = `lead-${seq}`;
  const config = templateYamlSchema.parse({
    name: "lead",
    display_name: "Lead",
    runtime: "local",
    secrets: ["GH_TOKEN"],
    skills: [],
    plugins: [],
  });
  const tdir = path.join(home, "templates/lead");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
  writeYaml("lead", {
    name: "lead",
    display_name: "Lead",
    runtime: "local",
    secrets: ["GH_TOKEN"],
    skills: [],
    plugins: [],
  });
  await t.db.insert(schema.credentials).values({
    id: "c1",
    name: "work",
    kind: "oauth_token",
    valueEnc: vault.seal("tok-1", "credentials:c1"),
  });
  await t.db.insert(schema.secrets).values({
    id: "s1",
    name: "GH_TOKEN",
    valueEnc: vault.seal("gh-1", "secrets:s1"),
  });
  await t.db.insert(schema.projects).values({ id: "p1", name: "app", hostPath: repo });
  await claimTestHandle(t.db, slug, "agent");
  const [row] = await t.db
    .insert(schema.agents)
    .values({
      id: `a-${seq}`,
      slug,
      displayName: "Lead",
      template: "lead",
      config: {},
      runtime: "local",
      credentialId: "c1",
    })
    .returning();
  if (!row) throw new Error("seed failed");
  agent = row;
  await t.db.insert(schema.agentProjectGrants).values({ agentId: agent.id, projectId: "p1" });
  lock = new KeyedMutex();
  const fake = createFakeClaude({ scenario: "reply" });
  const cliBundle = path.join(mkdtempSync(path.join(tmpdir(), "cli-")), "open-factory.js");
  writeFileSync(cliBundle, "//");
  workspace = new Workspace({
    factoryHome: home,
    hostSkillsDir: hs,
    claudeBin: fake.bin,
    cliBundle,
    lock,
  });
  const grants = [{ name: "app", hostPath: repo }];
  await workspace.materialize(
    agent.id,
    slug,
    { dir: tdir, config, tplSettings: {}, tplMcp: { mcpServers: {} } },
    {
      slug,
      displayName: "Lead",
      description: "",
      template: "lead",
      config,
      manager: null,
      grants,
    },
  );
  factoryConfig = loadConfig({
    DATABASE_URL: t.url,
    FACTORY_SECRET_KEY: KEY,
    FACTORY_HOME: home,
    FACTORY_ALLOW_LOCAL_RUNTIME: "true",
    LOG_LEVEL: "silent",
  });
  resolver = new ConfigResolver({
    templates: new TemplateIndex({ db: t.db, config: factoryConfig }),
  });
  const prepare = createPrepareStart({
    db: t.db,
    config: factoryConfig,
    vault,
    workspace,
    resolver,
    lock,
    neighborhood: new Neighborhood(t.db),
    serverEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      DATABASE_URL: "postgres://server-only",
      FACTORY_SECRET_KEY: KEY,
      SSH_AUTH_SOCK: "/tmp/ssh",
      ANTHROPIC_API_KEY: "server-own-key",
      CLAUDE_CODE_OAUTH_TOKEN: "server-own-token",
    },
  });
  prepareStart = (a, extra) => prepare(a, { ...extra, loaded: (id) => loaded.get(id) });
}
beforeEach(seedStartFixture);

test("assembles the spec: env has the decrypted credential and secret; files prepared", async () => {
  const spec = await prepareStart(agent, { agentToken: "tok" });
  expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-1");
  expect(spec.credentialId).toBe("c1");
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.cwd).toBe(path.join(home, "agents", agent.slug));
  expect(spec.runtime).toBe("local");
  expect(existsSync(path.join(spec.cwd, ".claude-config/CLAUDE.md"))).toBe(true);
  expect(existsSync(path.join(spec.cwd, "projects/app"))).toBe(true);
});

test("the child env is an allowlist: server secrets and own credentials never reach the agent", async () => {
  const { env } = await prepareStart(agent, { agentToken: "tok" });
  for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY"])
    expect(env).not.toHaveProperty(k);
  expect(Object.values(env)).not.toContain("server-own-key");
  expect(Object.values(env)).not.toContain("server-own-token");
  expect(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((k) => k in env)).toEqual([
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, "agents", agent.slug, ".claude-config"));
});

test("an api_key credential sets ANTHROPIC_API_KEY only", async () => {
  await t.sql`update credentials set kind = 'api_key', value_enc = ${vault.seal("key-1", "credentials:c1")}`;
  const { env } = await prepareStart(await reload(agent.id), { agentToken: "tok" });
  expect(env.ANTHROPIC_API_KEY).toBe("key-1");
  expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
});

test("the manager is described in CLAUDE.md", async () => {
  await claimTestHandle(t.db, "boss", "agent");
  const mgr = await t.db
    .insert(schema.agents)
    .values({
      id: "mgr",
      slug: "boss",
      displayName: "The Boss",
      template: "lead",
      config: {},
      runtime: "local",
      credentialId: "c1",
    })
    .returning();
  await t.sql`update agents set reports_to = ${mgr[0]?.id ?? ""} where id = ${agent.id}`;
  const spec = await prepareStart(agent, { agentToken: "tok" }); // stale row: prepareStart must reload
  const md = await import("node:fs").then((fs) =>
    fs.readFileSync(path.join(spec.cwd, ".claude-config/CLAUDE.md"), "utf8"),
  );
  expect(md).toContain("@boss");
});

test.each([
  [
    "missing secret",
    async () => t.sql`delete from secrets`,
    "Secret GH_TOKEN isn't set. Add it in Settings → Secrets.",
    "secrets",
  ],
  [
    "bad key",
    async () => t.sql`update credentials set value_enc = ${Buffer.from([1, 2, 3])}`,
    "Can't decrypt credential work. Was FACTORY_SECRET_KEY changed?",
    "credentials",
  ],
  [
    "bad secret blob",
    async () => t.sql`update secrets set value_enc = ${Buffer.from([1, 2, 3])}`,
    "Can't decrypt secret GH_TOKEN. Was FACTORY_SECRET_KEY changed?",
    "secrets",
  ],
  [
    "missing project folder",
    async () => t.sql`update projects set host_path = '/nonexistent/of-project'`,
    undefined,
    "projects",
  ],
])("fails closed: %s", async (_n, mutate, message, fix) => {
  await mutate();
  const row = await reload(agent.id);
  await expect(prepareStart(row, { agentToken: "tok" })).rejects.toMatchObject({
    name: "AgentStartError",
    ...(message ? { message } : {}),
    fix,
  });
});

test("archived agents never start", async () => {
  await t.sql`update agents set archived_at = now()`;
  await expect(prepareStart(await reload(agent.id), { agentToken: "tok" })).rejects.toMatchObject({
    name: "AgentArchivedError",
    message: `@${agent.slug} is archived. Restore it first.`,
  });
});

test("prepare runs under the workspace lock for the agent's slug", async () => {
  let release = () => {};
  const held = lock.run(
    agent.slug,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  let done = false;
  const p = prepareStart(agent, { agentToken: "tok" }).then((s) => {
    done = true;
    return s;
  });
  await new Promise((r) => setTimeout(r, 100));
  expect(done).toBe(false);
  release();
  await held;
  await p;
  expect(done).toBe(true);
});

test("an invalid overlay is an AgentStartError with the config fix", async () => {
  await t.db
    .update(schema.agents)
    .set({ config: { name: 5 } as never })
    .where(eq(schema.agents.id, agent.id));
  await expect(prepareStart(await reload(agent.id), { agentToken: "tok" })).rejects.toMatchObject({
    name: "AgentStartError",
    message: `The configuration of @${agent.slug} is invalid. Fix it in Configuration.`,
    fix: "config",
  });
});

test("an invalid or missing template fails the start with the template messages", async () => {
  writeTemplateFile("lead", "template.yaml", "name: [");
  await expect(prepareStart(agent, { agentToken: "tok" })).rejects.toMatchObject({
    message: "Template lead has errors. Fix it in Templates.",
    fix: "template",
  });
  rmSync(path.join(home, "templates/lead"), { recursive: true });
  await expect(prepareStart(agent, { agentToken: "tok" })).rejects.toMatchObject({
    message: "Template lead no longer exists.",
    fix: undefined,
  });
});

test("prepare writes the template plus the overlay: a deny rule appended and an mcp server added", async () => {
  writeTemplateFile(
    "lead",
    "settings.json",
    JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
  );
  writeTemplateFile("lead", "mcp.json", JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  await t.db
    .update(schema.agents)
    .set({
      config: {
        settings: { permissions: { deny: ["WebFetch"] } },
        mcp: { mcpServers: { b: { command: "b" } } },
      },
    })
    .where(eq(schema.agents.id, agent.id));
  const spec = await prepareStart(await reload(agent.id), { agentToken: "tok" });
  const deny = settingsOf(agent.slug).permissions.deny;
  expect(deny).toEqual(expect.arrayContaining(["Bash(rm:*)", "WebFetch"]));
  expect(deny.indexOf("Bash(rm:*)")).toBeLessThan(deny.indexOf("WebFetch"));
  const mcp = JSON.parse(readFileSync(path.join(spec.cwd, ".mcp.json"), "utf8"));
  expect(Object.keys(mcp.mcpServers)).toEqual(["a", "b", "factory"]);
  expect(spec.effective.config.secrets).toEqual(["GH_TOKEN"]);
});

test("prepare fails closed when .claude-config is a symlink to a host dir", async () => {
  const hostDir = mkdtempSync(path.join(tmpdir(), "host-"));
  const workdir = workspace.workdir(agent.slug);
  rmSync(`${workdir}/.claude-config`, { recursive: true, force: true });
  symlinkSync(hostDir, `${workdir}/.claude-config`);
  await expect(prepareStart(agent, { agentToken: "tok" })).rejects.toThrow(AgentStartError);
  await expect(prepareStart(agent, { agentToken: "tok" })).rejects.toThrow(/is a symlink/);
  expect(readdirSync(hostDir)).toEqual([]);
});

test("gate off: local start fails closed with fix=runtime, before prepare; nothing is touched", async () => {
  const prepare = vi.spyOn(workspace, "prepare");
  factoryConfig.allowLocalRuntime = false;
  try {
    await expect(prepareStart(agent, { agentToken: "tok" })).rejects.toMatchObject({
      name: "AgentStartError",
      message:
        "The local runtime is disabled on this factory. Set FACTORY_ALLOW_LOCAL_RUNTIME=true to run agents unsandboxed.",
      fix: "runtime",
    });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    factoryConfig.allowLocalRuntime = true;
    prepare.mockRestore();
  }
});

test("gate on: local starts as before", async () => {
  const spec = await prepareStart(agent, { agentToken: "tok" });
  expect(spec.runtime).toBe("local");
});

test("gate off: a docker agent is never gated", async () => {
  await t.db.update(schema.agents).set({ runtime: "docker" }).where(eq(schema.agents.id, agent.id));
  factoryConfig.allowLocalRuntime = false;
  try {
    const outcome = await prepareStart(await reload(agent.id), { agentToken: "tok" }).then(
      () => "started",
      (e: unknown) => e,
    );
    expect(outcome).not.toMatchObject({ fix: "runtime" });
  } finally {
    factoryConfig.allowLocalRuntime = true;
  }
});

// ---------- S7 §6.3: a spawned agent's start derives its inheritance from its spawner's current state ----------

const readlinkOrNull = (p: string) => {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
};
const leadTemplateSettings = () => path.join(home, "templates/lead/settings.json");
const md = (slug: string) =>
  readFileSync(path.join(workspace.workdir(slug), ".claude-config/CLAUDE.md"), "utf8");
const settingsOf = (slug: string) =>
  JSON.parse(
    readFileSync(path.join(workspace.workdir(slug), ".claude-config/settings.json"), "utf8"),
  );

/** The fixture's lead (secrets [GH_TOKEN], grant `app`, template deny `Bash(rm:*)`) spawned a child. */
async function seedChild(over: Record<string, unknown> = {}): Promise<AgentRow> {
  writeFileSync(
    leadTemplateSettings(),
    JSON.stringify({
      permissions: { deny: ["Bash(rm:*)"] },
      autoMode: { hard_deny: ["$defaults", "Never push to main"] },
    }),
  );
  await t.db.insert(schema.secrets).values({
    id: "s2",
    name: "NPM_TOKEN",
    valueEnc: vault.seal("npm-1", "secrets:s2"),
  });
  const config = templateYamlSchema.parse({
    name: "dev",
    display_name: "Dev",
    runtime: "local",
    secrets: ["GH_TOKEN", "NPM_TOKEN"],
    projects: ["app"],
    skills: [],
    plugins: [],
    ...over,
  });
  const tdir = path.join(home, "templates/dev");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Dev\n");
  writeYaml("dev", {
    name: "dev",
    display_name: "Dev",
    runtime: "local",
    secrets: ["GH_TOKEN", "NPM_TOKEN"],
    projects: ["app"],
    skills: [],
    plugins: [],
    ...over,
  });
  writeTemplateFile(
    "dev",
    "settings.json",
    JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] } }),
  );
  const slug = `dev-ab${seq}`;
  await claimTestHandle(t.db, slug, "agent");
  const [row] = await t.db
    .insert(schema.agents)
    .values({
      id: `child-${seq}`,
      slug,
      displayName: "Dev · ab",
      description: "Builds the thing.",
      template: "dev",
      config: {},
      runtime: config.runtime,
      credentialId: "c1",
      kind: "ephemeral",
      reportsTo: agent.id,
    })
    .returning();
  if (!row) throw new Error("seed failed");
  await t.db.insert(schema.agentProjectGrants).values({ agentId: row.id, projectId: "p1" });
  await workspace.materialize(
    row.id,
    slug,
    {
      dir: tdir,
      config,
      tplSettings: { permissions: { deny: ["Bash(curl:*)"] } },
      tplMcp: { mcpServers: {} },
    },
    {
      slug,
      displayName: "Dev · ab",
      description: "Builds the thing.",
      template: "dev",
      config,
      manager: { slug: agent.slug, displayName: "Lead" },
      grants: [{ name: "app", hostPath: repo }],
    },
  );
  return row;
}

test("a child's start: secrets ∩ spawner's (a dropped one doesn't fail), deny ∪ in settings.json, grants ∩ spawner's current", async () => {
  const child = await seedChild();
  const spec = await prepareStart(child, { agentToken: "tok" });
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.env.NPM_TOKEN).toBeUndefined();
  expect(Object.values(spec.env)).not.toContain("npm-1");
  const settings = settingsOf(child.slug);
  expect(settings.permissions.deny).toContain("Bash(rm:*)");
  expect(settings.permissions.deny).toContain("Bash(curl:*)");
  expect(settings.autoMode.hard_deny).toEqual(["$defaults", "Never push to main"]);
  expect(md(child.slug)).toContain("Environment variables provided to you: GH_TOKEN.");
  expect(readlinkOrNull(path.join(workspace.workdir(child.slug), "projects/app"))).not.toBeNull();
  // Revoked directly, without syncChildren: the child's start drops the grant anyway.
  await t.db
    .delete(schema.agentProjectGrants)
    .where(
      and(
        eq(schema.agentProjectGrants.agentId, agent.id),
        eq(schema.agentProjectGrants.projectId, "p1"),
      ),
    );
  await prepareStart(child, { agentToken: "tok" });
  expect(readlinkOrNull(path.join(workspace.workdir(child.slug), "projects/app"))).toBeNull();
  expect(md(child.slug)).toContain("No projects are granted to you.");
});

test("a child's start uses its spawner's current credential, even when its own row lags (no syncChildren)", async () => {
  const child = await seedChild();
  await t.db.insert(schema.credentials).values({
    id: "c2",
    name: "other",
    kind: "oauth_token",
    valueEnc: vault.seal("tok-2", "credentials:c2"),
  });
  // The spawner moved to c2 without its child following: the child must not keep a credential the spawner dropped.
  await t.db
    .update(schema.agents)
    .set({ credentialId: "c2" })
    .where(eq(schema.agents.id, agent.id));
  const spec = await prepareStart(child, { agentToken: "tok" });
  expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-2");
  expect(Object.values(spec.env)).not.toContain("tok-1");
  expect(spec.credentialId).toBe("c2"); // the runtime records turns and rate limits on it (S10 §5.2)
});

test("the spawner's current deny rules reach the child at its next start (no snapshot)", async () => {
  const child = await seedChild();
  await prepareStart(child, { agentToken: "tok" });
  writeFileSync(leadTemplateSettings(), JSON.stringify({ permissions: { deny: ["WebFetch"] } }));
  await prepareStart(child, { agentToken: "tok" });
  const deny = settingsOf(child.slug).permissions.deny;
  expect(deny).toContain("WebFetch");
  expect(deny).not.toContain("Bash(rm:*)");
  expect(deny).toContain("Bash(curl:*)");
});

test("a refusal that became true fails the start closed with the refusal sentence and no fix", async () => {
  const child = await seedChild();
  await t.db.update(schema.agents).set({ runtime: "docker" }).where(eq(schema.agents.id, agent.id));
  const prepare = vi.spyOn(workspace, "prepare");
  try {
    await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
      name: "AgentStartError",
      message: "Template dev runs locally, outside the sandbox you run in, so you can't spawn it.",
      fix: undefined,
    });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

test("bypass child of an auto spawner is refused at start", async () => {
  // A bypass template must be a Docker one to validate (permission_mode: bypass needs runtime: docker).
  const child = await seedChild({ permission_mode: "bypass", runtime: "docker" });
  await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
    message:
      "Template dev runs without permission checks, which you don't have, so you can't spawn it.",
    fix: undefined,
  });
});

test.each([
  [
    "its template is gone",
    async () => rmSync(path.join(home, "templates/lead"), { recursive: true }),
  ],
  ["its settings.json isn't JSON", async () => writeFileSync(leadTemplateSettings(), "{")],
  [
    "its template.yaml isn't valid",
    async () => writeTemplateFile("lead", "template.yaml", "name: ["),
  ],
  [
    "it is archived",
    async () =>
      t.db
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, agent.id)),
  ],
  [
    "its overlay is invalid",
    async () =>
      t.db
        .update(schema.agents)
        .set({ config: { name: 5 } as never })
        .where(eq(schema.agents.id, agent.id)),
  ],
])("a child fails closed when its spawner can't be read: %s", async (_n, mutate) => {
  const child = await seedChild();
  await mutate();
  const prepare = vi.spyOn(workspace, "prepare");
  try {
    await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
      name: "AgentStartError",
      message: expect.stringMatching(/(can't start| Terminate it and spawn a new one)\.$/),
      fix: undefined,
    });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

test("a spawner's CLAUDE.md has the Spawning section; its spawned report is quoted", async () => {
  await t.db
    .update(schema.agents)
    .set({ config: { template: { can_spawn: ["dev"], max_live_spawns: 3 } } })
    .where(eq(schema.agents.id, agent.id));
  const child = await seedChild({ description: "ignored" });
  await t.db
    .update(schema.agents)
    .set({ description: 'Ship "it" <now>' })
    .where(eq(schema.agents.id, child.id));
  await prepareStart(await reload(agent.id), { agentToken: "tok" });
  const lead = md(agent.slug);
  expect(lead).toContain("## Spawning");
  expect(lead).toContain("at most 3 live");
  expect(lead).toContain(`${factoryConfig.maxSpawnsPerHour} per hour`);
  expect(lead).toContain(`- @${child.slug} (Dev · ab), spawned by @${agent.slug}: "Ship 'it' now"`);
  await prepareStart(child, { agentToken: "tok" });
  const own = md(child.slug);
  expect(own).toContain(
    `You are a spawned agent: @${agent.slug} spawned you for one piece of work.`,
  );
  expect(own).toContain("## Your lifecycle");
  expect(own).not.toContain("## Spawning");
});

test("a persistent agent without can_spawn has no Spawning section", async () => {
  await prepareStart(agent, { agentToken: "tok" });
  expect(md(agent.slug)).not.toContain("## Spawning");
});

const setConfig = (id: string, config: Record<string, unknown>) =>
  t.db
    .update(schema.agents)
    .set({ config: config as never })
    .where(eq(schema.agents.id, id));

test("a spawned agent ignores its config: an invalid overlay doesn't stop its start", async () => {
  const child = await seedChild();
  await setConfig(child.id, { name: 5 });
  const spec = await prepareStart(await reload(child.id), { agentToken: "tok" });
  expect(spec.effective.config.name).toBe("dev");
});

test("a persistent agent's start errors keep their advice and fix; a spawned one's drop the config fix", async () => {
  await setConfig(agent.id, { name: 5 });
  const err = await prepareStart(await reload(agent.id), { agentToken: "tok" }).catch(
    (e: unknown) => e,
  );
  expect(err).toMatchObject({
    message: `The configuration of @${agent.slug} is invalid. Fix it in Configuration.`,
    fix: "config",
  });
  expect(forSpawnedAgent(err as AgentStartError).message).toBe(
    `The configuration of @${agent.slug} is invalid. Terminate it and spawn a new one.`,
  );
});

test("a spawned agent's start error from its template keeps the template fix", async () => {
  const child = await seedChild();
  writeTemplateFile("dev", "template.yaml", "name: [");
  const err = await prepareStart(child, { agentToken: "tok" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AgentStartError);
  expect(forSpawnedAgent(err as AgentStartError)).toMatchObject({
    message: "Template dev has errors. Fix it in Templates.",
    fix: "template",
  });
});

// The DB keeps a spawned row's reports_to set and pointing at a row (CHECK + FK), so these two are reached
// only through a stale row: deriveInheritance is called directly with one.
test.each([
  ["no spawner (null reports_to)", null],
  ["a spawner row that doesn't exist", "ghost"],
])("deriveInheritance fails closed with no fix: %s", async (_n, reportsTo) => {
  const child = await seedChild();
  const prepare = vi.spyOn(workspace, "prepare");
  try {
    await expect(
      deriveInheritance(
        { db: t.db, config: factoryConfig, resolver, loaded: () => undefined },
        { ...child, reportsTo },
        await resolver.effective(child),
      ),
    ).rejects.toMatchObject({
      name: "AgentStartError",
      message: `The agent that spawned @${child.slug} no longer exists, so @${child.slug} can't start.`,
      fix: undefined,
    });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

test.each([
  ["terminated (credential kept)", true],
  ["terminated with a null credential_id", false],
])("a child fails closed when its spawner is %s", async (_n, keepCredential) => {
  // Only an ephemeral row can be terminated, and only a terminated row can have a null credential (CHECKs),
  // so the spawner here is itself spawned by a top agent.
  const child = await seedChild();
  await claimTestHandle(t.db, `top-${seq}`, "agent");
  await t.db.insert(schema.agents).values({
    id: `top-${seq}`,
    slug: `top-${seq}`,
    displayName: "Top",
    template: "lead",
    config: {},
    runtime: "local",
    credentialId: "c1",
  });
  await t.db
    .update(schema.agents)
    .set({
      kind: "ephemeral",
      reportsTo: `top-${seq}`,
      terminatedAt: new Date(),
      terminatedBy: "@factory",
      credentialId: keepCredential ? "c1" : null,
    })
    .where(eq(schema.agents.id, agent.id));
  const prepare = vi.spyOn(workspace, "prepare");
  try {
    await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
      name: "AgentStartError",
      message: `@${agent.slug}, which spawned @${child.slug}, isn't active, so @${child.slug} can't start.`,
      fix: undefined,
    });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

// ---------- I2 §6.2: the stricter of the spawner's started and current config ----------

test("a loaded spawner counts as started ∩ current for secrets and started ∪ current for deny rules", async () => {
  const child = await seedChild();
  loaded.set(agent.id, await resolver.effective(agent)); // secrets [GH_TOKEN], deny Bash(rm:*)
  // The spawner's config moved on: it gained NPM_TOKEN and swapped its deny rule.
  writeFileSync(leadTemplateSettings(), JSON.stringify({ permissions: { deny: ["WebFetch"] } }));
  await t.db
    .update(schema.agents)
    .set({ config: { template: { secrets: ["NPM_TOKEN"] } } })
    .where(eq(schema.agents.id, agent.id));
  const spec = await prepareStart(child, { agentToken: "tok" });
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.env.NPM_TOKEN).toBeUndefined(); // gained since it started: not yet held by the running process
  const deny = settingsOf(child.slug).permissions.deny;
  expect(deny).toEqual(expect.arrayContaining(["Bash(rm:*)", "WebFetch", "Bash(curl:*)"]));
});

test("a spawner that isn't loaded counts as its current config alone", async () => {
  const child = await seedChild();
  writeFileSync(leadTemplateSettings(), JSON.stringify({ permissions: { deny: ["WebFetch"] } }));
  await t.db
    .update(schema.agents)
    .set({ config: { template: { secrets: ["NPM_TOKEN"] } } })
    .where(eq(schema.agents.id, agent.id));
  const spec = await prepareStart(child, { agentToken: "tok" });
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.env.NPM_TOKEN).toBe("npm-1");
  const deny = settingsOf(child.slug).permissions.deny;
  expect(deny).toContain("WebFetch");
  expect(deny).not.toContain("Bash(rm:*)");
});

test("spawning is computed from the effective config being prepared, not from started", async () => {
  loaded.set(agent.id, await resolver.effective(agent)); // started with no can_spawn
  await t.db
    .update(schema.agents)
    .set({ config: { template: { can_spawn: ["dev"] } } })
    .where(eq(schema.agents.id, agent.id));
  await prepareStart(await reload(agent.id), { agentToken: "tok" });
  expect(md(agent.slug)).toContain("## Spawning");
});

test("a spawner that dropped a secret and a deny rule since it started: the child still gets neither secret, and keeps the deny rule", async () => {
  const child = await seedChild();
  loaded.set(agent.id, await resolver.effective(agent)); // started with GH_TOKEN and Bash(rm:*)
  writeYaml("lead", { name: "lead", display_name: "Lead", runtime: "local", secrets: [] });
  writeFileSync(leadTemplateSettings(), JSON.stringify({}));
  const spec = await prepareStart(child, { agentToken: "tok" });
  expect(spec.env.GH_TOKEN).toBeUndefined();
  expect(spec.env.NPM_TOKEN).toBeUndefined();
  expect(settingsOf(child.slug).permissions.deny).toContain("Bash(rm:*)");
});

test("the stricter permission mode of started and current counts: a spawner that was auto at start still refuses a bypass child", async () => {
  const child = await seedChild({ permission_mode: "bypass", runtime: "docker" });
  loaded.set(agent.id, await resolver.effective(agent)); // started in auto
  // The template turns Docker to validate with bypass; the spawner keeps its row's local runtime (spec §6.6).
  writeYaml("lead", {
    name: "lead",
    display_name: "Lead",
    runtime: "docker",
    permission_mode: "bypass",
    secrets: ["GH_TOKEN"],
  });
  await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
    message:
      "Template dev runs without permission checks, which you don't have, so you can't spawn it.",
  });
  loaded.clear(); // not loaded: its current bypass mode alone counts
  // The refusal is checked before the runtime: this harness has no Docker, so getting that far means it passed.
  await expect(prepareStart(child, { agentToken: "tok" })).rejects.toMatchObject({
    message: "The Docker runtime isn't configured on this factory.",
  });
});

test("a spawner whose template is invalid fails the child's start generically, with no fix and no cause", async () => {
  const child = await seedChild();
  writeTemplateFile("lead", "template.yaml", "name: [");
  const err = await prepareStart(child, { agentToken: "tok" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AgentStartError);
  expect(err).toMatchObject({
    message: `The configuration of @${agent.slug}, which spawned @${child.slug}, can't be read, so @${child.slug} can't start.`,
    fix: undefined,
  });
  expect((err as Error).message).not.toContain("Template lead");
});
