import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { loggerOptions } from "./app.ts";
import { loadConfig } from "./config.ts";
import { makeTestApp } from "./test/helpers.ts";

test("the OAuth token is redacted at every realistic depth", async () => {
  const secret = "sk-ant-oat-FAKE-SECRET-123";
  const config = loadConfig({
    DATABASE_URL: "postgres://x/y",
    FACTORY_SECRET_KEY: "k".repeat(40),
    LOG_LEVEL: "info",
    NODE_ENV: "production",
  });
  const lines: string[] = [];
  const { transport: _t, ...opts } = loggerOptions(config) as ReturnType<typeof loggerOptions> & {
    transport?: unknown;
  };
  const app = Fastify({
    logger: { ...opts, stream: { write: (s: string) => void lines.push(s) } },
  });
  app.log.info({ env: { CLAUDE_CODE_OAUTH_TOKEN: secret } }, "env");
  app.log.info({ spec: { env: { CLAUDE_CODE_OAUTH_TOKEN: secret } } }, "spec");
  await app.close();
  const out = lines.join("");
  expect(out).toContain('"msg":"spec"');
  expect(out).not.toContain(secret);
});

test("buildApp canonicalizes FACTORY_HOME with realpath", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-link-")));
  mkdirSync(path.join(tmp, "real"));
  symlinkSync(path.join(tmp, "real"), path.join(tmp, "link"));
  const t = await makeTestApp({ env: { FACTORY_HOME: path.join(tmp, "link") } });
  try {
    expect(t.app.config.factoryHome).toBe(realpathSync(path.join(tmp, "link")));
    expect(t.app.config.factoryHome).toBe(path.join(tmp, "real"));
  } finally {
    await t.close();
  }
});
