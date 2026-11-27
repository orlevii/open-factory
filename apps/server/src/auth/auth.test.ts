import { schema } from "@open-factory/db";
import { refOf } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { principalsByHandles } from "../principals/principal-store.ts";
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

  test.each(["Bob", "-x", "humans", "me", "scheduler", "system", "all", "a"])(
    "invalid or reserved handle %s is rejected and creates no principal",
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
      expect(await principalOf(handle)).toBeUndefined();
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
  const NAME_MESSAGE = "Use 80 characters or fewer.";
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
      message: "Use 254 characters or fewer.",
    });
  });

  test("updating the name through /update-user is refused and changes nothing", async () => {
    const { cookie, user } = await signUp(t.app);
    for (const body of [{ name: "Renamed" }, { handle: "renamed" }]) {
      const res = await post("/api/auth/update-user", body, { cookie });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "USE_PATCH_ME" });
    }
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ name: user.name, handle: user.handle });
  });

  test("update-user without a name succeeds for a user whose stored name is 120 characters", async () => {
    const { cookie, user } = await signUp(t.app);
    await t.db
      .update(schema.users)
      .set({ name: "n".repeat(120) })
      .where(eq(schema.users.id, user.id));
    const res = await post(
      "/api/auth/update-user",
      { image: "https://example.com/a.png" },
      { cookie },
    );
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

const signUpBody = async (handle: string, email = `${handle}-${Date.now()}@example.com`) => ({
  invite: await testInvite(t.app),
  name: "X",
  handle,
  email,
  password: "password123",
});
const principalOf = async (handle: string) =>
  (await principalsByHandles(t.db, [handle])).get(handle);

describe("principals at sign-up (spec §4.1)", () => {
  test("sign-up creates a user and its principal with one UUID id", async () => {
    const { user } = await signUp(t.app, { handle: "one-id" });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await principalOf("one-id")).toMatchObject({ id: user.id, kind: "human" });
    const rows = await t.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(rows).toHaveLength(1);
  });

  test("GET /api/me returns the user's ref and handle", async () => {
    const { cookie, user } = await signUp(t.app, { handle: "me-ref" });
    const res = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(res.json()).toMatchObject({ id: user.id, handle: "me-ref", ref: refOf(user.id) });
  });

  test("sign-up with an agent's handle is refused with 422 and creates nothing", async () => {
    await insertAgent(t.sql, { id: "agent-claim", handle: "agentclaim" });
    await signUp(t.app, { handle: "someone-first" }); // an invite creator exists
    const before = await t.db.select().from(schema.principals);
    const res = await post("/api/auth/sign-up/email", await signUpBody("agentclaim"));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "HANDLE_TAKEN" });
    expect(await t.db.select().from(schema.principals)).toHaveLength(before.length);
    expect(
      await t.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, (await signUpBody("agentclaim")).email)),
    ).toEqual([]);
  });

  test("a failed sign-up leaves no principal behind", async () => {
    const first = await signUp(t.app, { handle: "orphan-owner" });
    const res = await post(
      "/api/auth/sign-up/email",
      await signUpBody("orphan-claim", first.input.email),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await principalOf("orphan-claim")).toBeUndefined();
    // The handle is free again for the next sign-up.
    const next = await signUp(t.app, { handle: "orphan-claim" });
    expect(await principalOf("orphan-claim")).toMatchObject({ id: next.user.id });
  });
});
