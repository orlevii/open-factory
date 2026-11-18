import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { HarnessDriver } from "@open-factory/harness";
import type { Me, SignUpInput } from "@open-factory/shared";
import type { FastifyInstance } from "fastify";
import { seedDevAgent } from "../agents/seed-dev.ts";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";

export const TEST_ORIGIN = "http://localhost:3000";

export interface TestAppOptions {
  webRoot?: string;
  env?: Record<string, string>;
  harnessDriver?: HarnessDriver;
}

export async function makeTestApp(opts: TestAppOptions = {}) {
  const tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const factoryHome = mkdtempSync(path.join(tmpdir(), "of-home-"));
  const build = async (o: TestAppOptions) => {
    const config = loadConfig({
      DATABASE_URL: tdb.url,
      FACTORY_SECRET_KEY: "t".repeat(40),
      PORT: "3000",
      LOG_LEVEL: "silent",
      FACTORY_HOME: factoryHome,
      CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      ...o.env,
    });
    const { db, sql, close: closeDb } = createDb(tdb.url);
    const app = await buildApp(config, {
      db,
      sql,
      webRoot: o.webRoot,
      logger: false,
      harnessDriver: o.harnessDriver,
    });
    return { app, config, db, sql, closeDb };
  };
  const first = await build(opts);
  const opened = [first];
  return {
    ...first,
    factoryHome,
    seed: () => seedDevAgent(first.db, first.config),
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
