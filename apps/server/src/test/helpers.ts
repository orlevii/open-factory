import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import type { Me, SignUpInput } from "@open-factory/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";

export const TEST_ORIGIN = "http://localhost:3000";

export async function makeTestApp(opts: { webRoot?: string } = {}) {
  const tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  const config = loadConfig({
    DATABASE_URL: tdb.url,
    FACTORY_SECRET_KEY: "t".repeat(40),
    PORT: "3000",
    LOG_LEVEL: "silent",
  });
  const { db, sql, close: closeDb } = createDb(tdb.url);
  const app = await buildApp(config, { db, sql, webRoot: opts.webRoot, logger: false });
  return {
    app,
    config,
    async close() {
      await app.close();
      await closeDb();
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
