import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRow, createDb, type Db, schema } from "@open-factory/db";
import { createMigratedTestDatabase } from "@open-factory/db/testing";
import type { HarnessDriver } from "@open-factory/harness";
import { createFakeClaude } from "@open-factory/harness/testing";
import {
  type AgentOverlay,
  agentOverlaySchema,
  type Me,
  type SignUpInput,
} from "@open-factory/shared";
import type { FastifyInstance } from "fastify";
import { type AppDeps, buildApp, loggerOptions } from "../app.ts";
import type { PasswordHasher } from "../auth/options.ts";
import { type Config, hostSkillsDirOf, loadConfig } from "../config.ts";
import type { Vault } from "../crypto/vault.ts";
import type { FactorySettingsValues } from "../settings/factory-settings.ts";
import { hashToken } from "../users/invites.ts";
import { agentConfigDir, agentWorkdir } from "../workspace/paths.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { seedTestPrincipal, testManagerUserId } from "./principals.ts";

export const TEST_ORIGIN = "http://localhost:3000";

/** The version floor runs `claude --version` before a local start, so a test app never relies on a `claude` on PATH
 *  (CI has none): `FACTORY_CLAUDE_BIN` is the fake's wrapper unless a test sets its own. One per process. */
let versionClaudeBin: string | undefined;
const versionOnlyClaude = () => {
  versionClaudeBin ??= createFakeClaude({ scenario: "reply" }).bin;
  return versionClaudeBin;
};

/** Each test app's database, so `signUp(app)` can mint an invite without changing its call sites. */
const appDbs = new WeakMap<FastifyInstance, Db>();

export interface TestAppOptions {
  webRoot?: string;
  env?: Record<string, string>;
  harnessDriver?: HarnessDriver;
  /** A fake Docker client for the whole app (images, containers); the real one when absent. */
  docker?: AppDeps["docker"];
  /** The scheduling clock and timer functions (S9); real ones when absent. */
  clock?: AppDeps["clock"];
  schedulerTimers?: AppDeps["schedulerTimers"];
  /** Capture the app's real log output (production redact config, no transport) at `logLevel`. */
  logStream?: { write(s: string): void };
  /** The capture's level; `"info"` when absent. */
  logLevel?: string;
  /** Spawns the sign-in bridge and python3 probe (I3); the real `spawn` when absent. */
  signInSpawn?: AppDeps["signInSpawn"];
  /** Written to the `factory_settings` row before the first boot only, not on `reopen()` (S10 §8.1: no longer env vars). */
  factorySettings?: Partial<FactorySettingsValues>;
}

/**
 * Salted scrypt like production, at a tiny cost factor: better-auth's default (N=16384, r=16) costs ~100 ms of CPU
 * per sign-up and sign-in, which dominated the suite under parallel load. Same hash/verify contract.
 */
export const testPasswordHasher: PasswordHasher = {
  async hash(password) {
    const salt = randomBytes(16);
    return `${salt.toString("hex")}:${scryptSync(password.normalize("NFKC"), salt, 32, { N: 16 }).toString("hex")}`;
  },
  async verify({ hash, password }) {
    const [salt, key] = hash.split(":");
    if (!salt || !key) return false;
    const expected = Buffer.from(key, "hex");
    const actual = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "hex"), 32, { N: 16 });
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  },
};

export async function makeTestApp(opts: TestAppOptions = {}) {
  const tdb = await createMigratedTestDatabase();
  const factoryHome = realpathSync(mkdtempSync(path.join(tmpdir(), "of-home-")));
  const hostClaudeDir = mkdtempSync(path.join(tmpdir(), "of-claude-"));
  mkdirSync(path.join(hostClaudeDir, "skills"));
  const build = async (o: TestAppOptions) => {
    const config = loadConfig({
      DATABASE_URL: tdb.url,
      FACTORY_SECRET_KEY: "t".repeat(40),
      PORT: "3000",
      LOG_LEVEL: "silent",
      FACTORY_HOME: factoryHome,
      FACTORY_HOST_CLAUDE_DIR: hostClaudeDir,
      FACTORY_ALLOW_LOCAL_RUNTIME: "true",
      // Every app binds a real agent listener: let the OS pick the port so test files can run in parallel.
      FACTORY_AGENT_PORT: "0",
      FACTORY_CLAUDE_BIN: versionOnlyClaude(),
      ...o.env,
    });
    const { db, sql, close: closeDb } = createDb(tdb.url);
    if (o.factorySettings && Object.keys(o.factorySettings).length > 0) {
      await db.update(schema.factorySettings).set({ settings: o.factorySettings });
    }
    const app = await buildApp(config, {
      db,
      sql,
      webRoot: o.webRoot,
      logger: o.logStream
        ? (() => {
            const { transport: _t, ...rest } = loggerOptions(config) as ReturnType<
              typeof loggerOptions
            > & { transport?: unknown };
            return { ...rest, level: o.logLevel ?? "info", stream: o.logStream };
          })()
        : false,
      harnessDriver: o.harnessDriver,
      passwordHasher: testPasswordHasher,
      ...(o.docker ? { docker: o.docker } : {}),
      ...(o.signInSpawn ? { signInSpawn: o.signInSpawn } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.schedulerTimers ? { schedulerTimers: o.schedulerTimers } : {}),
    });
    appDbs.set(app, db);
    return { app, config, db, sql, closeDb };
  };
  const first = await build(opts);
  const opened = [first];
  return {
    ...first,
    factoryHome,
    /** Where host skills are read from: `<config.hostClaudeDir>/skills`. */
    hostSkillsDir: hostSkillsDirOf(first.config),
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
    /** Reopens over the same database; `factorySettings` is not re-applied (a PATCH before the restart persists). */
    async reopen(o: TestAppOptions = { ...opts, factorySettings: undefined }) {
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
      await tdb.release();
    },
  };
}

export interface SeedAgentOptions {
  slug?: string;
  /** The agent's overlay (`agents.config`, I2 §5.1); `{}` runs exactly the `test` template. */
  config?: AgentOverlay;
  credentialValue?: string;
  /** The user it reports to; defaults to the oldest user (`testManagerUserId`). */
  reportsToUser?: string;
}

/** The `test` template every seeded agent is created from: local, nothing listed (I2: config comes from it live). */
export const TEST_TEMPLATE_YAML = "name: test\ndisplay_name: Test agent\nruntime: local\n";

/** A persistent agent with a credential and a minimal workdir, as if created from the `test` template. */
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
  const tplDir = path.join(app.config.factoryHome, "templates", "test");
  if (!existsSync(path.join(tplDir, "template.yaml"))) {
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(path.join(tplDir, "template.yaml"), TEST_TEMPLATE_YAML);
    writeFileSync(path.join(tplDir, "AGENTS.md"), "# Test agent\n");
  }
  const principal = await seedTestPrincipal(app.db, "agent", slug);
  const [row] = await app.db
    .insert(schema.agents)
    .values({
      id: principal.id,
      slug,
      displayName: "Test agent",
      description: "",
      template: "test",
      config: agentOverlaySchema.parse(opts.config ?? {}),
      runtime: "local",
      credentialId,
      reportsToUser: opts.reportsToUser ?? (await testManagerUserId(app.db)),
    })
    .returning();
  if (!row) throw new Error("seed failed");
  const workdir = agentWorkdir(app.config.factoryHome, slug);
  mkdirSync(agentConfigDir(workdir), { recursive: true });
  writeFileSync(path.join(workdir, "AGENTS.md"), "# Test agent\n");
  return row;
}

/**
 * An invite token for the next sign-up when the factory already has users (S10 §9.3), inserted directly
 * (hashed, created by any user, far-future expiry so fake clocks don't expire it); undefined with zero users.
 */
export async function testInvite(app: FastifyInstance): Promise<string | undefined> {
  const db = appDbs.get(app);
  if (!db) throw new Error("testInvite: app was not built by makeTestApp");
  const [creator] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (!creator) return undefined;
  const token = randomBytes(32).toString("base64url");
  await db.insert(schema.invites).values({
    id: randomUUID(),
    tokenHash: hashToken(token),
    createdBy: creator.id,
    expiresAt: new Date("9999-01-01T00:00:00Z"),
  });
  return token;
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
  const invite = await testInvite(app);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: TEST_ORIGIN },
    payload: invite ? { ...body, invite } : body,
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
  const tdb = await createMigratedTestDatabase();
  const h = createDb(tdb.url);
  return {
    ...h,
    url: tdb.url,
    async close() {
      await h.close();
      await tdb.release();
    },
  };
}
