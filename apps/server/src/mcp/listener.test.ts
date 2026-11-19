import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, expect, test } from "vitest";
import { resolveAgentBindHosts } from "./bind-hosts.ts";
import { startAgentListener } from "./listener.ts";
import { AgentTokens } from "./tokens.ts";

const log = {
  fatal() {},
  trace() {},
  silent() {},
  level: "info",
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return log;
  },
} as never;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(over: Partial<Parameters<typeof startAgentListener>[0]> = {}) {
  const tokens = new AgentTokens();
  const seen: string[] = [];
  const l = await startAgentListener({
    hosts: ["127.0.0.1"],
    port: 0,
    allowedSources: ["127.0.0.0/8", "::1/128"],
    version: "9.9.9",
    tokens,
    isArchived: async () => false,
    mcp: async (_r, id) => {
      seen.push(id);
      return new Response("{}", { status: 200 });
    },
    log,
    ...over,
  });
  close = l.close;
  return { url: `http://127.0.0.1:${l.port}`, tokens, seen };
}

test("401 before MCP without or with a bad token; 200 with a valid one", async () => {
  const { url, tokens, seen } = await start();
  expect((await fetch(`${url}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
  expect(
    (
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer x" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(seen).toEqual([]);
  const { token } = tokens.mint("ag1");
  expect(
    (
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(seen).toEqual(["ag1"]);
});
test("Origin → 403, GET/DELETE /mcp → 405, status has no DB and no auth", async () => {
  const { url, tokens } = await start();
  const { token } = tokens.mint("ag1");
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "http://evil" },
    body: "{}",
  });
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({
    error: { code: "forbidden_origin", message: "Origin not allowed" },
  });
  expect(
    (await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(405);
  expect(
    (await fetch(`${url}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(405);
  expect(await (await fetch(`${url}/api/status`)).json()).toEqual({ version: "9.9.9" });
});
test("an archived agent's token is refused", async () => {
  const { url, tokens } = await start({ isArchived: async () => true });
  const { token } = tokens.mint("ag1");
  expect(
    (
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      })
    ).status,
  ).toBe(401);
});
test("a source outside the allowed ranges is closed", async () => {
  const { url } = await start({ allowedSources: ["10.99.0.0/16"] });
  await expect(fetch(`${url}/api/status`)).rejects.toThrow();
});
test("a specific bind address accepts callers by the range of the interface that carries it", async () => {
  const nets = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
  } as never;
  const { hosts, allowedSources } = resolveAgentBindHosts({
    platform: "linux",
    override: ["127.0.0.1"],
    interfaces: nets,
    localAllowed: true,
    warn() {},
  });
  const { url } = await start({ hosts, allowedSources });
  expect((await fetch(`${url}/api/status`)).status).toBe(200);
  const other = await start({
    hosts,
    allowedSources: allowedSources.filter((c) => !c.startsWith("127.")),
  });
  await expect(fetch(`${other.url}/api/status`)).rejects.toThrow();
});
test("an explicit all-addresses setting accepts any caller and warns exactly once at startup", async () => {
  const warns: string[] = [];
  const r = resolveAgentBindHosts({
    platform: "linux",
    override: ["0.0.0.0"],
    interfaces: {} as never,
    localAllowed: true,
    warn: (m) => warns.push(m),
  });
  expect(warns).toHaveLength(1);
  const { url } = await start({ hosts: ["127.0.0.1"], allowedSources: r.allowedSources });
  expect((await fetch(`${url}/api/status`)).status).toBe(200);
  expect(warns).toHaveLength(1);
});
test("a body over 512 KiB is refused before MCP", async () => {
  const { url, tokens, seen } = await start();
  const { token } = tokens.mint("ag1");
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ x: "y".repeat(600 * 1024) }),
  });
  expect(r.status).toBe(413);
  expect(seen).toEqual([]);
});
test("logs redact the authorization header", async () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(c, _e, cb) {
      lines.push(String(c));
      cb();
    },
  });
  // The request serializer includes headers so a missing redact path would leak the token.
  const logger = Fastify({
    logger: { level: "info", stream: sink, serializers: { req: (r) => ({ headers: r.headers }) } },
  }).log;
  const { url, tokens } = await start({ log: logger as never });
  const { token } = tokens.mint("ag1");
  await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  const out = lines.join("");
  expect(out).toContain("incoming request");
  expect(out).toContain("[Redacted]");
  expect(out).not.toContain(token);
});
