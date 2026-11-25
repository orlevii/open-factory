import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { makeTestApp, testInvite } from "../test/helpers.ts";

const HTTPS = "https://factory.example.com";
const DIRECT = "http://127.0.0.1:3000";
/** A browser behind the TLS proxy (the proxy is 127.0.0.1, inject's default peer), and one on the direct port. */
const viaProxy = { host: "factory.example.com", "x-forwarded-proto": "https", origin: HTTPS };
const direct = { host: "127.0.0.1:3000", origin: DIRECT };

type App = Awaited<ReturnType<typeof makeTestApp>>;
const env = { PUBLIC_URL: HTTPS, EXTRA_PUBLIC_ORIGINS: DIRECT };

let n = 0;
async function signUpOn(t: App, headers: Record<string, string>) {
  n += 1;
  return t.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers,
    payload: {
      invite: await testInvite(t.app),
      name: `P ${n}`,
      handle: `po-${n}-${Date.now() % 100000}`,
      email: `po${n}-${Date.now()}@example.com`,
      password: "password123",
    },
  });
}
const sessionCookie = (res: { headers: Record<string, unknown> }) =>
  ([res.headers["set-cookie"]].flat() as string[]).find((c) => c.includes("session_token"));
const pair = (c: string | undefined) => (c ?? "").split(";")[0] ?? "";
const me = (t: App, headers: Record<string, string>) =>
  t.app.inject({ method: "GET", url: "/api/me", headers });

describe("PUBLIC_URL behind a trusted TLS proxy, plus a direct http origin", () => {
  let t: App;
  beforeAll(async () => {
    t = await makeTestApp({ env: { ...env, TRUST_PROXY: "127.0.0.1" } });
  });
  afterAll(() => t.close());

  test("each origin gets its own kind of cookie, and its session works on that origin", async () => {
    const secure = await signUpOn(t, viaProxy);
    expect(secure.statusCode).toBe(200);
    const sc = sessionCookie(secure);
    expect(sc).toMatch(/^__Secure-better-auth\.session_token=/);
    expect(sc).toMatch(/;\s*Secure/i);
    expect((await me(t, { ...viaProxy, cookie: pair(sc) })).statusCode).toBe(200);

    const plain = await signUpOn(t, direct);
    expect(plain.statusCode).toBe(200);
    const pc = sessionCookie(plain);
    expect(pc).toMatch(/^better-auth\.session_token=/);
    expect(pc).not.toMatch(/;\s*Secure/i);
    expect((await me(t, { ...direct, cookie: pair(pc) })).statusCode).toBe(200);
  });

  test("the session records the client's address from the trusted proxy's X-Forwarded-For", async () => {
    const res = await signUpOn(t, { ...viaProxy, "x-forwarded-for": "203.0.113.9" });
    expect(res.statusCode).toBe(200);
    const [row] = await t.sql`select ip_address from sessions order by created_at desc limit 1`;
    expect(row?.ip_address).toBe("203.0.113.9");
  });

  test("the WebSocket accepts the direct origin with its session, and refuses an origin that isn't public", async () => {
    const cookie = pair(sessionCookie(await signUpOn(t, direct)));
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (t.app.server.address() as AddressInfo).port;
    const open = (origin: string) =>
      new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
          headers: { ...direct, origin, cookie },
        });
        ws.once("message", (d) => {
          resolve(JSON.parse(String(d)));
          ws.close();
        });
        ws.once("unexpected-response", (_q, r) => reject(new Error(`status ${r.statusCode}`)));
        ws.once("error", reject);
      });
    expect(await open(DIRECT)).toMatchObject({ type: "hello" });
    await expect(open("http://evil.example")).rejects.toThrow("status 401");
  });
});

describe("without TRUST_PROXY", () => {
  let t: App;
  beforeAll(async () => {
    t = await makeTestApp({ env });
  });
  afterAll(() => t.close());

  test("X-Forwarded-For is ignored: the session records the socket's address", async () => {
    const res = await signUpOn(t, { ...viaProxy, "x-forwarded-for": "203.0.113.9" });
    expect(res.statusCode).toBe(200);
    const [row] = await t.sql`select ip_address from sessions order by created_at desc limit 1`;
    expect(row?.ip_address).toBe("127.0.0.1");
  });
});
