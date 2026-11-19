import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type Config, loadConfig } from "../config.ts";
import { Vault } from "../crypto/vault.ts";
import { createTestDb } from "../test/helpers.ts";
import { KeyedMutex } from "../workspace/lock.ts";
import { Workspace } from "../workspace/workspace.ts";
import { AgentStartError } from "./errors.ts";
import { createPrepareStart, type PrepareStart } from "./start.ts";

const KEY = "k".repeat(40);
let t: Awaited<ReturnType<typeof createTestDb>>;
let home: string;
let repo: string;
let hs: string;
let workspace: Workspace;
let lock: KeyedMutex;
let prepareStart: PrepareStart;
let factoryConfig: Config;
let agent: AgentRow;
let seq = 0;
const vault = new Vault(KEY);

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function reload(id: string): Promise<AgentRow> {
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, id));
  if (!row) throw new Error("no agent");
  return row;
}

async function seedStartFixture() {
  seq += 1;
  await t.sql`delete from agent_project_grants`;
  await t.sql`delete from agents`;
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
  const [row] = await t.db
    .insert(schema.agents)
    .values({
      id: `a-${seq}`,
      slug,
      displayName: "Lead",
      template: "lead",
      config,
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
  prepareStart = createPrepareStart({
    db: t.db,
    config: factoryConfig,
    vault,
    workspace,
    lock,
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
}
beforeEach(seedStartFixture);

test("assembles the spec: env has the decrypted credential and secret; files prepared", async () => {
  const spec = await prepareStart(agent);
  expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-1");
  expect(spec.env.GH_TOKEN).toBe("gh-1");
  expect(spec.cwd).toBe(path.join(home, "agents", agent.slug));
  expect(spec.runtime).toBe("local");
  expect(existsSync(path.join(spec.cwd, ".claude-config/CLAUDE.md"))).toBe(true);
  expect(existsSync(path.join(spec.cwd, "projects/app"))).toBe(true);
});

test("the child env is an allowlist: server secrets and own credentials never reach the agent", async () => {
  const { env } = await prepareStart(agent);
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
  const { env } = await prepareStart(await reload(agent.id));
  expect(env.ANTHROPIC_API_KEY).toBe("key-1");
  expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
});

test("the manager is described in CLAUDE.md", async () => {
  const mgr = await t.db
    .insert(schema.agents)
    .values({
      id: "mgr",
      slug: "boss",
      displayName: "The Boss",
      template: "lead",
      config: agent.config,
      runtime: "local",
      credentialId: "c1",
    })
    .returning();
  await t.sql`update agents set reports_to = ${mgr[0]?.id ?? ""} where id = ${agent.id}`;
  const spec = await prepareStart(agent); // stale row: prepareStart must reload
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
  await expect(prepareStart(row)).rejects.toMatchObject({
    name: "AgentStartError",
    ...(message ? { message } : {}),
    fix,
  });
});

test("archived agents never start", async () => {
  await t.sql`update agents set archived_at = now()`;
  await expect(prepareStart(await reload(agent.id))).rejects.toMatchObject({
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
  const p = prepareStart(agent).then((s) => {
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

test("an invalid stored config is an AgentStartError with the edit_agent fix", async () => {
  await t.db
    .update(schema.agents)
    .set({ config: { name: 5 } as never })
    .where(eq(schema.agents.id, agent.id));
  await expect(prepareStart(agent)).rejects.toMatchObject({
    name: "AgentStartError",
    fix: "edit_agent",
  });
});

test("prepare fails closed when .claude-config is a symlink to a host dir", async () => {
  const hostDir = mkdtempSync(path.join(tmpdir(), "host-"));
  const workdir = workspace.workdir(agent.slug);
  rmSync(`${workdir}/.claude-config`, { recursive: true, force: true });
  symlinkSync(hostDir, `${workdir}/.claude-config`);
  await expect(prepareStart(agent)).rejects.toThrow(AgentStartError);
  await expect(prepareStart(agent)).rejects.toThrow(/is a symlink/);
  expect(readdirSync(hostDir)).toEqual([]);
});

test("gate off: local start fails closed with fix=runtime, before prepare; nothing is touched", async () => {
  const prepare = vi.spyOn(workspace, "prepare");
  factoryConfig.allowLocalRuntime = false;
  try {
    await expect(prepareStart(agent)).rejects.toMatchObject({
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
  const spec = await prepareStart(agent);
  expect(spec.runtime).toBe("local");
});

test("gate off: a docker agent is never gated", async () => {
  await t.db.update(schema.agents).set({ runtime: "docker" }).where(eq(schema.agents.id, agent.id));
  factoryConfig.allowLocalRuntime = false;
  try {
    const outcome = await prepareStart(await reload(agent.id)).then(
      () => "started",
      (e: unknown) => e,
    );
    expect(outcome).not.toMatchObject({ fix: "runtime" });
  } finally {
    factoryConfig.allowLocalRuntime = true;
  }
});
