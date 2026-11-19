import Fastify from "fastify";
import { expect, test } from "vitest";
import { loggerOptions } from "./app.ts";
import { loadConfig } from "./config.ts";

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
