import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ev, FakeDriver } from "./agents/testing/fake-driver.ts";
import { makeTestApp } from "./test/helpers.ts";
import { installPlugins } from "./workspace/plugins.ts";

// Spec 11.1: credential values, secret values and plugin stderr never reach the log output.
const CRED = "sk-ant-oat01-SENTINEL-CREDENTIAL-VALUE";
const SECRET = "SENTINEL-SECRET-VALUE-9f3a";
const URL_CRED = "user:pass@host";
const GH = "ghp_SENTINELPLUGINTOKEN123";

const lines: string[] = [];
const out = () => lines.join("");
const driver = new FakeDriver();
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;

const watcher = setInterval(() => {
  for (const p of driver.starts) {
    if ((p as unknown as { answered?: boolean }).answered) continue;
    (p as unknown as { answered?: boolean }).answered = true;
    p.emit(ev.session(), ev.turn(), ev.end());
  }
}, 5);

beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver, logStream: { write: (s) => void lines.push(s) } });
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(async () => {
  clearInterval(watcher);
  await t.close();
});

test("the capture is live: an unredacted field does show up", () => {
  t.app.log.info({ marker: "visible-marker" }, "probe");
  expect(out()).toContain("visible-marker");
});

test("POST /api/credentials and PUT /api/secrets/:name never log their values", async () => {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/credentials",
    headers: { cookie },
    payload: { name: "work", kind: "oauth_token", value: CRED },
  });
  expect(created.statusCode).toBe(201);
  const put = await t.app.inject({
    method: "PUT",
    url: "/api/secrets/MY_SECRET",
    headers: { cookie },
    payload: { value: SECRET },
  });
  expect(put.statusCode).toBe(200);
  // Failure paths log too (validation error, duplicate).
  await t.app.inject({
    method: "POST",
    url: "/api/credentials",
    headers: { cookie },
    payload: { name: "work", kind: "oauth_token", value: CRED },
  });
  await t.app.inject({
    method: "PUT",
    url: "/api/secrets/bad name",
    headers: { cookie },
    payload: { value: SECRET },
  });
  await t.app.close();
  expect(out()).toContain('"msg":"incoming request"');
  expect(out()).not.toContain(CRED);
  expect(out()).not.toContain(SECRET);
});

test("a plugin install failure with URL credentials and a token in stderr is never logged raw", async () => {
  const ref = `https://${URL_CRED}/${GH}@mk`;
  const fake = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_PLUGIN_FAIL: ref } });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  const err = await installPlugins({
    claudeBin: fake.bin,
    configDir: cfg,
    cwd: cfg,
    plugins: [ref],
    tplSettings: {
      extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/x/mk" } } },
    },
    serverEnv: process.env,
  }).catch((e) => e);
  expect(err.output).toContain("[redacted]");
  // The way the app logs failures: the error itself, and its output field.
  const log = t.app.log;
  log.error({ err }, "plugin install failed");
  log.warn({ output: err.output, detail: { output: err.output } }, "plugin output");
  expect(out()).toContain("plugin install failed");
  expect(out()).not.toContain("user:pass");
  expect(out()).not.toContain(GH);
});

test("the new redact paths hide sentinels at every shape", () => {
  const S = "SENTINEL-REDACT-VALUE-77";
  const log = t.app.log;
  log.info({ x: { ANTHROPIC_API_KEY: S } }, "a1");
  log.info({ env: { ANTHROPIC_API_KEY: S } }, "a2");
  log.info({ spec: { env: { ANTHROPIC_API_KEY: S } } }, "a3");
  log.info({ secret: { value: S } }, "v1");
  log.info({ body: { inner: { value: S } } }, "v2");
  log.info({ cred: { token: S } }, "t1");
  log.info({ spec: { env: { ANY_NAME: S, OTHER: S } } }, "e1");
  log.info({ req: { password: S }, password: S }, "p1");
  const text = out();
  for (const m of ["a1", "a2", "a3", "v1", "v2", "t1", "e1", "p1"])
    expect(text).toContain(`"msg":"${m}"`);
  expect(text).not.toContain(S);
});
