import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentRow,
  createDb,
  type Db,
  MIGRATIONS_DIR,
  migrate,
  schema,
} from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { HarnessDriver } from "@open-factory/harness";
import {
  type Me,
  type SignUpInput,
  type TemplateConfig,
  templateConfigSchema,
} from "@open-factory/shared";
import type { FastifyInstance } from "fastify";
import { buildApp, loggerOptions } from "../app.ts";
import { type Config, loadConfig } from "../config.ts";
import type { Vault } from "../crypto/vault.ts";
import { agentConfigDir, agentWorkdir, templateCopyDir } from "../workspace/paths.ts";
import type { Workspace } from "../workspace/workspace.ts";

export const TEST_ORIGIN = "http://localhost:3000";

export interface TestAppOptions {
  webRoot?: string;
  env?: Record<string, string>;
  harnessDriver?: HarnessDriver;
  /** Capture the app's real log output (production redact config, no transport) at info level. */
  logStream?: { write(s: string): void };
}

export async function makeTestApp(opts: TestAppOptions = {}) {
  const tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const factoryHome = realpathSync(mkdtempSync(path.join(tmpdir(), "of-home-")));
  const hostSkillsDir = mkdtempSync(path.join(tmpdir(), "of-skills-"));
  const build = async (o: TestAppOptions) => {
    const config = loadConfig({
      DATABASE_URL: tdb.url,
      FACTORY_SECRET_KEY: "t".repeat(40),
      PORT: "3000",
      LOG_LEVEL: "silent",
      FACTORY_HOME: factoryHome,
      FACTORY_HOST_SKILLS_DIR: hostSkillsDir,
      FACTORY_ALLOW_LOCAL_RUNTIME: "true",
      ...o.env,
    });
    const { db, sql, close: closeDb } = createDb(tdb.url);
    const app = await buildApp(config, {
      db,
      sql,
      webRoot: o.webRoot,
      logger: o.logStream
        ? (() => {
            const { transport: _t, ...rest } = loggerOptions(config) as ReturnType<
              typeof loggerOptions
            > & { transport?: unknown };
            return { ...rest, level: "info", stream: o.logStream };
          })()
        : false,
      harnessDriver: o.harnessDriver,
    });
    return { app, config, db, sql, closeDb };
  };
  const first = await build(opts);
  const opened = [first];
  return {
    ...first,
    factoryHome,
    seedAgent: (o?: SeedAgentOptions) =>
      seedTestAgent(
        {
          db: first.db,
          config: first.config,
          vault: first.app.vault,
          workspace: first.app.workspace,
        },
        o,
      ),
    signUpUser: (input?: Partial<SignUpInput>) => signUp(first.app, input),
    /** A second app on the same DB and FACTORY_HOME (the first should be closed first). */
    async reopen(o: TestAppOptions = opts) {
      const next = await build(o);
      opened.push(next);
      return next;
    },
    async close() {
      // Tests may already have closed an app (restart tests); both closes tolerate a second call.
      for (const o of [...opened].reverse()) {
        await o.app.close().catch(() => {});
        await o.closeDb().catch(() => {});
      }
      await tdb.drop();
    },
  };
}

export interface SeedAgentOptions {
  slug?: string;
  config?: Partial<TemplateConfig>;
  credentialValue?: string;
}

/** A persistent agent with a credential and a minimal workdir, as if created from a template. */
export async function seedTestAgent(
  app: { db: Db; config: Config; vault: Vault; workspace: Workspace },
  opts: SeedAgentOptions = {},
): Promise<AgentRow> {
  const slug = opts.slug ?? "dev";
  const credentialId = randomUUID();
  await app.db.insert(schema.credentials).values({
    id: credentialId,
    name: `test-cred-${credentialId.slice(0, 8)}`,
    kind: "oauth_token",
    valueEnc: app.vault.seal(opts.credentialValue ?? "test-token", `credentials:${credentialId}`),
  });
  const config = templateConfigSchema.parse({
    name: "test",
    displayName: "Test agent",
    description: "",
    runtime: "local",
    permissionMode: "auto",
    projects: [],
    skills: [],
    localSkills: true,
    plugins: [],
    secrets: [],
    canSpawn: [],
    maxLiveSpawns: 5,
    warmWindowMinutes: 70,
    ...opts.config,
  });
  const [row] = await app.db
    .insert(schema.agents)
    .values({
      id: randomUUID(),
      slug,
      displayName: "Test agent",
      description: "",
      template: "test",
      config,
      runtime: "local",
      credentialId,
    })
    .returning();
  if (!row) throw new Error("seed failed");
  const workdir = agentWorkdir(app.config.factoryHome, slug);
  mkdirSync(agentConfigDir(workdir), { recursive: true });
  mkdirSync(templateCopyDir(workdir), { recursive: true });
  writeFileSync(path.join(workdir, "AGENTS.md"), "# Test agent\n");
  writeFileSync(path.join(templateCopyDir(workdir), "settings.json"), "{}");
  writeFileSync(path.join(templateCopyDir(workdir), "mcp.json"), '{"mcpServers":{}}');
  return row;
}

let n = 0;
export async function signUp(app: FastifyInstance, input: Partial<SignUpInput> = {}) {
  n += 1;
  const body: SignUpInput = {
    name: `User ${n}`,
    handle: `user-${n}-${Date.now() % 100000}`,
    email: `u${n}-${Date.now()}@example.com`,
    password: "password123",
    ...input,
  };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: TEST_ORIGIN },
    payload: body,
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed ${res.statusCode}: ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
    .map((c) => c.split(";")[0])
    .join("; ");
  const token = String(res.headers["set-auth-token"] ?? "");
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  return { cookie, token, user: me.json() as Me, input: body };
}

/** A migrated throwaway database for unit tests that don't need the app. */
export async function createTestDb() {
  const tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const h = createDb(tdb.url);
  return {
    ...h,
    url: tdb.url,
    async close() {
      await h.close();
      await tdb.drop();
    },
  };
}
