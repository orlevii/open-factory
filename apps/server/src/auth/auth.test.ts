import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import * as principals from "../messaging/principals.ts";
import { makeTestApp, signUp, TEST_ORIGIN, testInvite } from "../test/helpers.ts";
import { signUpMutex } from "../users/sign-up-gate.ts";

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

describe("name and email lengths (spec §13.2)", () => {
  const NAME_MESSAGE = "Keep your name to 80 characters or fewer.";
  const emailOf = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
  const signUpBody = async (fields: Record<string, unknown>) => ({
    invite: await testInvite(t.app),
    password: "password123",
    ...fields,
  });

  test("sign-up with an 81-character name is 400 NAME_TOO_LONG, even without a handle", async () => {
    const withHandle = await post(
      "/api/auth/sign-up/email",
      await signUpBody({ name: "n".repeat(81), handle: "long-name", email: emailOf(40) }),
    );
    expect(withHandle.statusCode).toBe(400);
    expect(withHandle.json()).toMatchObject({ code: "NAME_TOO_LONG", message: NAME_MESSAGE });
    const withoutHandle = await post(
      "/api/auth/sign-up/email",
      await signUpBody({ name: "n".repeat(81), email: emailOf(41) }),
    );
    expect(withoutHandle.statusCode).toBe(400);
    expect(withoutHandle.json()).toMatchObject({ code: "NAME_TOO_LONG" });
  });

  test("sign-up with a 255-character email is 400 EMAIL_TOO_LONG", async () => {
    const res = await post(
      "/api/auth/sign-up/email",
      await signUpBody({ name: "Long", handle: "long-email", email: emailOf(255) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "EMAIL_TOO_LONG",
      message: "Keep your email to 254 characters or fewer.",
    });
  });

  test("update-user with an 81-character name is 400 NAME_TOO_LONG", async () => {
    const { cookie } = await signUp(t.app);
    const res = await post("/api/auth/update-user", { name: "n".repeat(81) }, { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "NAME_TOO_LONG" });
  });

  test("update-user without a name succeeds for a user whose stored name is 120 characters", async () => {
    const { cookie, user } = await signUp(t.app);
    await t.db
      .update(schema.users)
      .set({ name: "n".repeat(120) })
      .where(eq(schema.users.id, user.id));
    const res = await post("/api/auth/update-user", { handle: `${user.handle}-b` }, { cookie });
    expect(res.statusCode).toBe(200);
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

const countHandles = async (h: string) => {
  const [r] = await t.sql`select count(*)::int as n from handles where handle = ${h}`;
  return r?.n as number;
};
const signUpBody = async (handle: string, email = `${handle}-${Date.now()}@example.com`) => ({
  invite: await testInvite(t.app),
  name: "X",
  handle,
  email,
  password: "password123",
});

describe("handle claims (spec §4.1)", () => {
  test("sign-up with an agent's slug is 422 HANDLE_TAKEN", async () => {
    await insertAgent(t.sql, { id: "agent-claim", slug: "agentclaim" });
    await signUp(t.app, { handle: "someone-first" }); // an invite creator exists
    const res = await post("/api/auth/sign-up/email", await signUpBody("agentclaim"));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "HANDLE_TAKEN" });
  });

  test("a sign-up that fails with an email in use leaves a claim the next sign-up reclaims", async () => {
    const first = await signUp(t.app, { handle: "orphan-owner" });
    const res = await post(
      "/api/auth/sign-up/email",
      await signUpBody("orphan-claim", first.input.email),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await countHandles("orphan-claim")).toBe(1);
    const [u] = await t.sql`select id from users where handle = 'orphan-claim'`;
    expect(u).toBeUndefined();
    await signUp(t.app, { handle: "orphan-claim" });
    expect(await countHandles("orphan-claim")).toBe(1);
  });

  test("update-user with a handle and no session is 401 and leaves no handles row", async () => {
    const res = await post("/api/auth/update-user", { handle: "squatter" });
    expect(res.statusCode).toBe(401);
    expect(await countHandles("squatter")).toBe(0);
  });

  test("update-user to an invalid handle is 400 and claims nothing", async () => {
    const { cookie } = await signUp(t.app);
    for (const handle of ["Bad_Handle", "humans"]) {
      const res = await post("/api/auth/update-user", { handle }, { cookie });
      expect(res.statusCode).toBe(400);
      expect(await countHandles(handle)).toBe(0);
    }
  });

  test("update-user keeping one's own handle is not a change", async () => {
    const { cookie, user } = await signUp(t.app);
    const spy = vi.spyOn(principals, "claimHandle");
    try {
      const res = await post(
        "/api/auth/update-user",
        { handle: user.handle, name: "Renamed" },
        { cookie },
      );
      expect(res.statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("update-user to an agent's handle is 422 HANDLE_TAKEN; to a free one claims it", async () => {
    const { cookie } = await signUp(t.app);
    const taken = await post("/api/auth/update-user", { handle: "agentclaim" }, { cookie });
    expect(taken.statusCode).toBe(422);
    expect(taken.json()).toMatchObject({ code: "HANDLE_TAKEN" });
    const ok = await post("/api/auth/update-user", { handle: "renamed-free" }, { cookie });
    expect(ok.statusCode).toBe(200);
    expect(await countHandles("renamed-free")).toBe(1);
  });

  test("the claim runs before better-auth writes the user, on sign-up and update-user", async () => {
    const order: string[] = [];
    const real = principals.claimHandle;
    const spy = vi.spyOn(principals, "claimHandle").mockImplementation(async (...a) => {
      order.push(`claim:${a[1]}`);
      return real(...a);
    });
    const ctx = await t.app.auth.$context;
    const adapter = ctx.internalAdapter;
    const realCreate = adapter.createUser.bind(adapter);
    const createSpy = vi.spyOn(adapter, "createUser").mockImplementation(async (...a) => {
      order.push("createUser");
      return realCreate(...a);
    });
    const realUpdate = adapter.updateUser.bind(adapter);
    const updateSpy = vi.spyOn(adapter, "updateUser").mockImplementation(async (...a) => {
      order.push("updateUser");
      return realUpdate(...a);
    });
    try {
      const { cookie } = await signUp(t.app, { handle: "order-one" });
      await post("/api/auth/update-user", { handle: "order-two" }, { cookie });
      expect(order).toEqual(["claim:order-one", "createUser", "claim:order-two", "updateUser"]);
    } finally {
      spy.mockRestore();
      createSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("update-user and sign-up are serialised under the same mutex key", async () => {
    const keys: string[] = [];
    const real = signUpMutex.run.bind(signUpMutex);
    const spy = vi.spyOn(signUpMutex, "run").mockImplementation((key, fn) => {
      keys.push(key);
      return real(key, fn);
    });
    try {
      const { cookie } = await signUp(t.app);
      const [a, b] = await Promise.all([
        post("/api/auth/update-user", { handle: "mutex-one" }, { cookie }),
        post("/api/auth/update-user", { handle: "mutex-two" }, { cookie }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(keys).toEqual(["sign-up", "sign-up", "sign-up"]); // the sign-up above, then both updates
    } finally {
      spy.mockRestore();
    }
  });
});
