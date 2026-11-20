import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { makeTestApp, signUp, TEST_ORIGIN, testInvite } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: "POST",
    url,
    headers: { origin: TEST_ORIGIN, ...headers },
    payload: payload as object,
  });

describe("sign-up and /api/me", () => {
  test("sign-up returns a session; /api/me works with cookie and with bearer", async () => {
    const { cookie, token, user, input } = await signUp(t.app, { handle: "alice", name: "Alice" });
    expect(user).toMatchObject({ handle: "alice", name: "Alice", email: input.email });
    expect(user.id).toEqual(expect.any(String));
    expect(token).not.toBe("");
    const viaBearer = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaBearer.json()).toEqual(user);
    const viaCookie = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(viaCookie.json()).toEqual(user);
  });

  test("/api/me without a session is 401 in the factory error shape", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "Not signed in" } });
  });

  test("a second user can sign up; duplicate handle is HANDLE_TAKEN; duplicate email rejected", async () => {
    const first = await signUp(t.app, { handle: "bob" });
    const dupHandle = await post("/api/auth/sign-up/email", {
      invite: await testInvite(t.app),
      name: "B2",
      handle: "bob",
      email: "other@example.com",
      password: "password123",
    });
    expect(dupHandle.statusCode).toBe(422);
    expect(dupHandle.json()).toMatchObject({ code: "HANDLE_TAKEN" });
    const dupEmail = await post("/api/auth/sign-up/email", {
      invite: await testInvite(t.app),
      name: "B3",
      handle: "bob-two",
      email: first.input.email,
      password: "password123",
    });
    expect(dupEmail.statusCode).toBeGreaterThanOrEqual(400);
    expect(dupEmail.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  });

  test.each(["Bob", "-x", "humans", "me", "scheduler", "a"])(
    "invalid or reserved handle %s is rejected",
    async (handle) => {
      const res = await post("/api/auth/sign-up/email", {
        invite: await testInvite(t.app),
        name: "X",
        handle,
        email: `${handle}-${Date.now()}@example.com`,
        password: "password123",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    },
  );

  test("sign-out with bearer and {} body revokes the token", async () => {
    const { token } = await signUp(t.app);
    const out = await post("/api/auth/sign-out", {}, { authorization: `Bearer ${token}` });
    expect(out.statusCode).toBe(200);
    const me = await t.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("auth bridge", () => {
  test("client-supplied X-Forwarded-For is replaced with the socket IP", async () => {
    const spy = vi.spyOn(t.app.auth, "handler");
    try {
      const res = await post(
        "/api/auth/sign-up/email",
        {
          invite: await testInvite(t.app),
          name: "Spoof",
          handle: `spoof-${Date.now() % 100000}`,
          email: `spoof-${Date.now()}@example.com`,
          password: "password123",
        },
        { "x-forwarded-for": "6.6.6.6" },
      );
      expect(res.statusCode).toBe(200);
      const forwarded = spy.mock.calls[0]?.[0] as Request;
      expect(forwarded.headers.get("x-forwarded-for")).toBe("127.0.0.1"); // inject's remoteAddress
      const token = String(res.headers["set-auth-token"]);
      const session = await t.app.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      expect(session?.session.ipAddress).toBe("127.0.0.1");
    } finally {
      spy.mockRestore();
    }
  });

  test("the client's content-length is not forwarded with the re-serialized body", async () => {
    const spy = vi.spyOn(t.app.auth, "handler");
    try {
      const body = '{ "email" : "nobody@example.com" , "password" : "password123" }';
      await t.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        payload: body,
      });
      const forwarded = spy.mock.calls[0]?.[0] as Request;
      expect(forwarded.headers.get("content-length")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("error shape", () => {
  test("Fastify 4xx errors map to bad_request and keep their status", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
  });

  test("unsupported media type keeps 415 with code bad_request", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TEST_ORIGIN, "content-type": "application/x-nope" },
      payload: "x",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});
