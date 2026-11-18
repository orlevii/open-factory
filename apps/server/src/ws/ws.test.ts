import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
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

function open(headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; first: unknown }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
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
