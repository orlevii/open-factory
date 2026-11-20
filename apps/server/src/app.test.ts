import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import { ev, FakeDriver } from "./agents/testing/fake-driver.ts";
import { AGENT_URL_ON_HUMAN_PORT_WARNING, loggerOptions } from "./app.ts";
import { loadConfig } from "./config.ts";
import { callTool, mcpCall } from "./mcp/testing/mcp-client.ts";
import { makeTestApp, signUp } from "./test/helpers.ts";

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

test("the agent listener is up after buildApp, its port reaches the config, and close revokes tokens then closes it", async () => {
  const t = await makeTestApp({ harnessDriver: new FakeDriver() });
  const port = t.app.agentListener.port;
  expect(port).toBeGreaterThan(0);
  expect(t.app.config.agentPort).toBe(port);
  expect(t.app.config.agentUrl).toBe(`http://host.docker.internal:${port}`);
  const url = `http://127.0.0.1:${port}`;
  expect(await (await fetch(`${url}/api/status`)).json()).toEqual({
    version: expect.any(String),
  });
  const { token } = t.app.agentTokens.mint("someone");
  await t.app.close();
  expect(t.app.agentTokens.verify(token)).toBeUndefined();
  await expect(fetch(`${url}/api/status`)).rejects.toThrow();
  await t.close();
});

test("a FACTORY_AGENT_URL on the human port logs the upgrade warning", async () => {
  const lines: string[] = [];
  // The human port is set here, not taken from the helper's default, and read back from the app's config.
  const t = await makeTestApp({
    harnessDriver: new FakeDriver(),
    env: { PORT: "4719", FACTORY_AGENT_URL: "http://host.docker.internal:4719" },
    logStream: { write: (l) => void lines.push(l) },
  });
  try {
    expect(new URL(t.app.config.agentUrl).port).toBe(String(t.app.config.port));
    expect(lines.join("")).toContain(AGENT_URL_ON_HUMAN_PORT_WARNING);
  } finally {
    await t.close();
  }
  const quiet: string[] = [];
  const u = await makeTestApp({
    harnessDriver: new FakeDriver(),
    logStream: { write: (l) => void quiet.push(l) },
  });
  await u.close();
  expect(quiet.join("")).not.toContain(AGENT_URL_ON_HUMAN_PORT_WARNING);
});

/** Starts `slug` with a human message and an idle first turn; returns its live token. */
async function startIdle(
  t: Awaited<ReturnType<typeof makeTestApp>>,
  driver: FakeDriver,
  slug: string,
) {
  const { cookie } = await signUp(t.app, { handle: `h-${slug}` });
  await t.app.inject({
    method: "POST",
    url: `/api/agents/${slug}/messages`,
    headers: { cookie },
    payload: { body: "hi" },
  });
  const p = driver.starts.filter((s) => s.spec.slug === slug).at(-1);
  if (!p) throw new Error(`${slug} not started`);
  p.emit(...ev.fullTurn());
  await (await t.app.runtimes.bySlug(slug))?.settled();
  return { proc: p, token: p.spec.env.OPEN_FACTORY_AGENT_TOKEN as string };
}

/** Every agent's tools: messaging (S6) and tasks (S8 §9). */
const BASE_TOOLS = [
  "comment_task",
  "create_task",
  "get_task",
  "list_peers",
  "list_tasks",
  "send_message",
  "update_task",
];

test("tools per caller: spawner sees two more with the enum, others the messaging and task tools (spec §7.1, S8 §9)", async () => {
  const driver = new FakeDriver();
  const t = await makeTestApp({ harnessDriver: driver });
  try {
    await t.seedAgent({
      slug: "lead",
      config: { canSpawn: ["tech-lead", "developer"], maxLiveSpawns: 5 },
    });
    await t.seedAgent({ slug: "solo" });
    await t.seedAgent({ slug: "capped", config: { canSpawn: ["developer"], maxLiveSpawns: 0 } });
    const url = `http://127.0.0.1:${t.app.agentListener.port}`;
    const names = async (slug: string) => {
      const { token } = await startIdle(t, driver, slug);
      const r = await mcpCall(url, token, "tools/list", {});
      return r.json.result.tools as {
        name: string;
        inputSchema: { properties: Record<string, { enum?: string[] }> };
      }[];
    };
    const lead = await names("lead");
    expect(lead.map((x) => x.name).sort()).toEqual(
      [...BASE_TOOLS, "spawn_agent", "terminate_agent"].sort(),
    );
    expect(
      lead.find((x) => x.name === "spawn_agent")?.inputSchema.properties.template?.enum,
    ).toEqual(["tech-lead", "developer"]);
    expect((await names("solo")).map((x) => x.name).sort()).toEqual(BASE_TOOLS);
    expect((await names("capped")).map((x) => x.name).sort()).toEqual(BASE_TOOLS);
    // A spawned agent never spawns (depth one), even when its template has can_spawn.
    const tplDir = path.join(t.factoryHome, "templates", "developer");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(
      path.join(tplDir, "template.yaml"),
      "name: developer\ndisplay_name: Developer\nruntime: local\ncan_spawn:\n  - developer\n",
    );
    writeFileSync(path.join(tplDir, "AGENTS.md"), "# Developer\n");
    const leadRow = await t.app.store.agentBySlug("lead");
    const spawned = await t.app.spawner.spawn(
      leadRow?.id ?? "",
      { template: "developer", suffix: "e1", description: "Builds it", prompt: "Build it" },
      null,
    );
    expect(spawned).toMatchObject({ ok: true, slug: "developer-e1" });
    // The brief wakes it: take that process's token once its first turn is over.
    await vi.waitFor(() =>
      expect(driver.starts.some((s) => s.spec.slug === "developer-e1")).toBe(true),
    );
    const p = driver.starts.filter((s) => s.spec.slug === "developer-e1").at(-1);
    p?.emit(...ev.fullTurn());
    await (await t.app.runtimes.bySlug("developer-e1"))?.settled();
    const r = await mcpCall(url, p?.spec.env.OPEN_FACTORY_AGENT_TOKEN as string, "tools/list", {});
    expect((r.json.result.tools as { name: string }[]).map((x) => x.name).sort()).toEqual(
      BASE_TOOLS,
    );
  } finally {
    await t.close();
  }
});

test("an agent token never reaches the logs, on the agent listener or the REST API", async () => {
  const lines: string[] = [];
  const driver = new FakeDriver();
  const t = await makeTestApp({
    harnessDriver: driver,
    logStream: { write: (l) => void lines.push(l) },
  });
  try {
    await t.seedAgent({ slug: "dev" });
    const { token } = await startIdle(t, driver, "dev");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const url = `http://127.0.0.1:${t.app.agentListener.port}`;
    await callTool(url, token, "list_peers", {});
    await callTool(url, token, "send_message", { to: "@h-dev", body: "for the inbox" });
    await expect(callTool(url, `${token}x`, "list_peers", {})).rejects.toThrow("401");
    for (const route of ["/api/agents", "/api/inbox", "/api/messages/nope"]) {
      const r = await t.app.inject({
        method: "GET",
        url: route,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode, route).toBe(401);
    }
    const out = lines.join("");
    expect(out).toContain('"url":"/mcp"'); // the listener's request lines are there
    expect(out).not.toContain(token);
  } finally {
    await t.close();
  }
});

test("FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS reaches the runtimes: 0 writes a member update at once", async () => {
  const driver = new FakeDriver();
  const t = await makeTestApp({
    harnessDriver: driver,
    env: { FACTORY_MEMBER_UPDATE_DEBOUNCE_SECONDS: "0" },
  });
  try {
    const lead = await t.seedAgent({ slug: "lead" });
    const dev = await t.seedAgent({ slug: "dev" });
    await t.sql`update agents set reports_to = ${lead.id} where id = ${dev.id}`;
    const { proc } = await startIdle(t, driver, "lead");
    const row = await t.app.store.createHeld({
      kind: "member_update",
      toAgentId: lead.id,
      fromAgentId: dev.id,
      body: "progress",
    });
    const rt = await t.app.runtimes.bySlug("lead");
    await rt?.receiveHeld(row);
    await rt?.settled();
    expect(proc.sent.flat().map((m) => m.body)).toContain("progress");
  } finally {
    await t.close();
  }
});
