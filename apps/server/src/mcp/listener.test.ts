import { connect } from "node:net";
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
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
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
  closers.push(l.close);
  return { url: `http://127.0.0.1:${l.port}`, tokens, seen };
}

async function startOnPort() {
  const r = await start();
  return { ...r, port: Number(new URL(r.url).port) };
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
test("the listener accepts a source inside an allowed range and refuses one outside", async () => {
  const inside = await start({ allowedSources: ["127.0.0.0/24"] });
  expect((await fetch(`${inside.url}/api/status`)).status).toBe(200);
  const outside = await start({ allowedSources: ["127.1.0.0/24"] });
  await expect(fetch(`${outside.url}/api/status`)).rejects.toThrow();
});
test("a malformed Host header cannot break the MCP request", async () => {
  const { port, tokens } = await startOnPort();
  const { token } = tokens.mint("ag1");
  const body = "{}";
  const status = await new Promise<string>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () =>
      sock.write(
        `POST /mcp HTTP/1.1\r\nHost: bad host/<>\r\nauthorization: Bearer ${token}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
      ),
    );
    let data = "";
    sock.on("data", (c) => {
      data += c;
    });
    sock.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    sock.on("error", reject);
  });
  expect(status).toBe("HTTP/1.1 200 OK");
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

/**
 * Claude Code's `subscriptions/listen` (protocol 2026-07-28) gets an SSE stream that never ends; Claude waits for its
 * first event (the acknowledgement) before it lists the tools. The listener must stream it, not buffer it.
 */
function sseHandler() {
  let cancelled!: () => void;
  const cancelledP = new Promise<void>((r) => {
    cancelled = r;
  });
  let aborted!: () => void;
  const abortedP = new Promise<void>((r) => {
    aborted = r;
  });
  const mcp = async (req: Request) => {
    req.signal.addEventListener("abort", () => aborted());
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: message\ndata: {"ack":true}\n\n'));
      },
      cancel() {
        cancelled();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { mcp, cancelled: cancelledP, aborted: abortedP };
}
async function openStream(url: string, token: string, signal?: AbortSignal) {
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","id":"listen:0","method":"subscriptions/listen"}',
    ...(signal ? { signal } : {}),
  });
  const reader = r.body?.getReader();
  const first = await reader?.read();
  return { r, reader, first: new TextDecoder().decode(first?.value) };
}

test("an SSE response is streamed: headers and the first event arrive while the stream stays open", async () => {
  const h = sseHandler();
  const { url, tokens } = await start({ mcp: h.mcp });
  const { r, reader, first } = await openStream(url, tokens.mint("ag1").token);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  expect(first).toContain('data: {"ack":true}');
  await reader?.cancel();
});

test("a client disconnect cancels the upstream stream and aborts the handler's request", async () => {
  const h = sseHandler();
  const { url, tokens } = await start({ mcp: h.mcp });
  const ac = new AbortController();
  const { first } = await openStream(url, tokens.mint("ag1").token, ac.signal);
  expect(first).toContain("ack");
  ac.abort();
  await Promise.all([h.cancelled, h.aborted]);
});

test("close() resolves while an SSE stream is open, and the stream is cancelled", async () => {
  const h = sseHandler();
  const servers = () =>
    process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
  const before = servers();
  const tokens = new AgentTokens();
  const l = await startAgentListener({
    hosts: ["127.0.0.1"],
    port: 0,
    allowedSources: ["127.0.0.0/8"],
    version: "9.9.9",
    tokens,
    isArchived: async () => false,
    mcp: h.mcp,
    log,
  });
  const { reader, first } = await openStream(
    `http://127.0.0.1:${l.port}`,
    tokens.mint("ag1").token,
  );
  expect(first).toContain("ack");
  await l.close();
  await h.cancelled;
  // No listening socket left behind.
  expect(servers()).toBeLessThanOrEqual(before);
  // The client side sees the stream end (closed or errored), never a hang.
  await reader?.read().catch(() => undefined);
});
