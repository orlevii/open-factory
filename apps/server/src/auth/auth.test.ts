import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";

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
      name: "B2",
      handle: "bob",
      email: "other@example.com",
      password: "password123",
    });
    expect(dupHandle.statusCode).toBe(422);
    expect(dupHandle.json()).toMatchObject({ code: "HANDLE_TAKEN" });
    const dupEmail = await post("/api/auth/sign-up/email", {
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
