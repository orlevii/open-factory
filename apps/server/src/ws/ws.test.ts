import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let session: Awaited<ReturnType<typeof signUp>>;
beforeAll(async () => {
  t = await makeTestApp();
  session = await signUp(t.app);
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/ws`;
});
afterAll(async () => {
  await t.close();
});

function open(headers: Record<string, string>, target = url) {
  return new Promise<{ ws: WebSocket; first: unknown }>((resolve, reject) => {
    const ws = new WebSocket(target, { headers });
    ws.once("message", (d) => resolve({ ws, first: JSON.parse(String(d)) }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

test("cookie + matching origin: hello, then ping/pong, invalid message gets error", async () => {
  const { ws, first } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  expect(first).toEqual({ type: "hello", userId: session.user.id });
  const next = () =>
    new Promise<unknown>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ type: "ping" }));
  expect(await next()).toEqual({ type: "pong" });
  ws.send("not json");
  expect(await next()).toMatchObject({ type: "error", code: "bad_message" });
  ws.close();
});

test("bearer without origin is accepted", async () => {
  const { ws, first } = await open({ authorization: `Bearer ${session.token}` });
  expect(first).toMatchObject({ type: "hello" });
  ws.close();
});

test.each([
  ["no session", { origin: TEST_ORIGIN }],
  ["bad origin", { cookie: "", origin: "http://evil.example" }],
  ["no origin without bearer", { cookie: "" }],
])("rejects %s with 401", async (_name, headers) => {
  const h = { ...headers } as Record<string, string>;
  if ("cookie" in h) h.cookie = session.cookie;
  await expect(open(h)).rejects.toThrow("status 401");
});

test("a frame over 64 KiB closes the socket with 1009", async () => {
  const { ws } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  ws.send(JSON.stringify({ type: "ping", pad: "x".repeat(64 * 1024) }));
  expect(await closed).toBe(1009);
});

test("a frame of just under 64 KiB is still processed", async () => {
  const { ws } = await open({ cookie: session.cookie, origin: TEST_ORIGIN });
  const reply = new Promise<unknown>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ type: "ping", pad: "x".repeat(60 * 1024) }));
  expect(await reply).toEqual({ type: "pong" });
  ws.close();
});

describe("DEV_WEB_ORIGIN gating", () => {
  const DEV_ORIGIN = "http://localhost:5173";

  test("development: the dev web origin is accepted and trusted by better-auth", async () => {
    expect(t.config.isProduction).toBe(false);
    expect(t.app.auth.options.trustedOrigins).toContain(DEV_ORIGIN);
    const { ws, first } = await open({ cookie: session.cookie, origin: DEV_ORIGIN });
    expect(first).toMatchObject({ type: "hello" });
    ws.close();
  });

  describe("production", () => {
    let prod: Awaited<ReturnType<typeof makeTestApp>>;
    let prodUrl: string;
    let prodSession: Awaited<ReturnType<typeof signUp>>;
    beforeAll(async () => {
      prod = await makeTestApp({ env: { NODE_ENV: "production" } });
      prodSession = await signUp(prod.app);
      await prod.app.listen({ port: 0, host: "127.0.0.1" });
      prodUrl = `ws://127.0.0.1:${(prod.app.server.address() as AddressInfo).port}/api/ws`;
    });
    afterAll(async () => {
      await prod.close();
    });

    test("the dev web origin is rejected with 401 and not trusted by better-auth", async () => {
      expect(prod.config.isProduction).toBe(true);
      expect(prod.app.auth.options.trustedOrigins).toEqual([TEST_ORIGIN]);
      await expect(
        open({ cookie: prodSession.cookie, origin: DEV_ORIGIN }, prodUrl),
      ).rejects.toThrow("status 401");
    });

    test("PUBLIC_URL's origin is still accepted", async () => {
      const { ws, first } = await open(
        { cookie: prodSession.cookie, origin: TEST_ORIGIN },
        prodUrl,
      );
      expect(first).toMatchObject({ type: "hello" });
      ws.close();
    });
  });
});
