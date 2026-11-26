import type { AddressInfo } from "node:net";
import { schema } from "@open-factory/db";
import type { ServerMessage, UserAdminItem } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { principalsByHandles } from "../principals/principal-store.ts";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";

/** S10 §9.4, §13, AC6: disable and enable users. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let al: Awaited<ReturnType<typeof signUp>>;
const PASSWORD = "password123";

beforeEach(async () => {
  h = await makeTestApp();
  or = await signUp(h.app, { handle: "or" });
  al = await signUp(h.app, { handle: "al" });
});
afterEach(() => h.close());

const as = (s: { cookie: string }, method: "GET" | "POST", url: string) =>
  h.app.inject({ method, url, headers: { cookie: s.cookie, origin: TEST_ORIGIN } });

/** Sign in as the CLI does and return its bearer token (a second `sessions` row). */
async function cliSignIn(email: string) {
  return h.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
}

const meStatus = async (headers: Record<string, string>) =>
  (await h.app.inject({ method: "GET", url: "/api/me", headers })).statusCode;

const disabledAtOf = async (id: string) =>
  (await h.db.select().from(schema.users).where(eq(schema.users.id, id)))[0]?.disabledAt ?? null;

describe("disable", () => {
  test("deletes the cookie session and a CLI bearer token: both get 401", async () => {
    const signedIn = await cliSignIn(al.input.email);
    expect(signedIn.statusCode).toBe(200);
    const bearer = String(signedIn.headers["set-auth-token"]);
    expect(await meStatus({ cookie: al.cookie })).toBe(200);
    expect(await meStatus({ authorization: `Bearer ${bearer}` })).toBe(200);

    const res = await as(or, "POST", `/api/users/${al.user.id}/disable`);
    expect(res.statusCode).toBe(200);

    expect(await meStatus({ cookie: al.cookie })).toBe(401);
    expect(await meStatus({ authorization: `Bearer ${bearer}` })).toBe(401);
    expect(await meStatus({ authorization: `Bearer ${al.token}` })).toBe(401);
    const left = await h.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, al.user.id));
    expect(left).toEqual([]);
    const [row] = await h.db.select().from(schema.users).where(eq(schema.users.id, al.user.id));
    expect(row?.disabledAt).not.toBeNull();
    expect(row?.disabledBy).toBe(or.user.id);
    // The disabler is untouched.
    expect(await meStatus({ cookie: or.cookie })).toBe(200);
  });

  test("a user who manages agents is refused with 409 manages_agents naming them; nothing is disabled or signed out", async () => {
    await h.seedAgent({ slug: "ada", reportsTo: al.user.id });
    await h.seedAgent({ slug: "bob", reportsTo: al.user.id });
    await h.seedAgent({ slug: "cy", reportsTo: or.user.id });
    const res = await as(or, "POST", `/api/users/${al.user.id}/disable`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "manages_agents", agents: ["ada", "bob"] });
    expect(res.json().error.message).toContain("@ada, @bob");
    expect(await disabledAtOf(al.user.id)).toBeNull();
    expect(await meStatus({ cookie: al.cookie })).toBe(200);
  });

  test("once the agents are moved to another manager, the human can be disabled", async () => {
    await h.seedAgent({ slug: "ada", reportsTo: al.user.id });
    expect((await as(or, "POST", `/api/users/${al.user.id}/disable`)).statusCode).toBe(409);
    await h.sql`update agents set reports_to = ${or.user.id} where slug = 'ada'`;
    expect((await as(or, "POST", `/api/users/${al.user.id}/disable`)).statusCode).toBe(200);
  });

  test("a disabled user with a surviving session row still gets 401 (enforced on every request)", async () => {
    await h.db
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, al.user.id));
    expect(await meStatus({ cookie: al.cookie })).toBe(401);
    expect(await meStatus({ authorization: `Bearer ${al.token}` })).toBe(401);
  });

  test("sign-in of a disabled user is 403 USER_DISABLED; enable restores sign-in", async () => {
    expect((await as(or, "POST", `/api/users/${al.user.id}/disable`)).statusCode).toBe(200);
    const refused = await cliSignIn(al.input.email);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "USER_DISABLED",
      message: "This account is disabled.",
    });

    expect((await as(or, "POST", `/api/users/${al.user.id}/enable`)).statusCode).toBe(204);
    expect(await disabledAtOf(al.user.id)).toBeNull();
    const ok = await cliSignIn(al.input.email);
    expect(ok.statusCode).toBe(200);
    expect(await meStatus({ authorization: `Bearer ${ok.headers["set-auth-token"]}` })).toBe(200);
  });

  test("revokes the user's pending invites and returns the count; enable does not restore them", async () => {
    const mine = await h.app.invites.create(al.user.id);
    await h.app.invites.create(al.user.id);
    const used = await h.app.invites.create(al.user.id);
    await h.app.invites.markUsed(used.invite.id, or.user.id);
    const others = await h.app.invites.create(or.user.id);

    const res = await as(or, "POST", `/api/users/${al.user.id}/disable`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revokedInvites: 2 });
    expect((await h.app.invites.listPending()).map((i) => i.id)).toEqual([others.invite.id]);

    await as(or, "POST", `/api/users/${al.user.id}/enable`);
    expect(await h.app.invites.check(new URL(mine.link).searchParams.get("invite") ?? "")).toBe(
      null,
    );
  });

  test("disable and enable publish users_changed after commit", async () => {
    // Read the row when each frame arrives: a publish before the commit would see the old state.
    const seen: Promise<Date | null>[] = [];
    const off = h.app.bus.subscribeAll((m) => {
      if (m.type === "users_changed") seen.push(disabledAtOf(al.user.id));
    });
    try {
      await as(or, "POST", `/api/users/${al.user.id}/disable`);
      await as(or, "POST", `/api/users/${al.user.id}/enable`);
    } finally {
      off();
    }
    const states = await Promise.all(seen);
    expect(states).toHaveLength(2);
    expect(states[0]).toBeInstanceOf(Date);
    expect(states[1]).toBeNull();
  });

  test("self is 409 cannot_disable_self", async () => {
    const res = await as(or, "POST", `/api/users/${or.user.id}/disable`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
    expect(await disabledAtOf(or.user.id)).toBeNull();
  });

  test("the last enabled user is 409 last_enabled_user", async () => {
    // Only reachable through the service (over HTTP the actor is always another enabled user).
    await h.db
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, al.user.id));
    await expect(h.app.userAdmin.disable(al.user.id, or.user.id)).rejects.toMatchObject({
      status: 409,
      code: "last_enabled_user",
    });
    expect(await disabledAtOf(or.user.id)).toBeNull();
  });

  test("an actor disabled after authenticating can't disable or enable anyone (401)", async () => {
    const cy = await signUp(h.app, { handle: "cy" });
    // As if a disable of al committed while al's request waited on the user locks.
    await h.db
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, al.user.id));
    await expect(h.app.userAdmin.disable(al.user.id, cy.user.id)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    expect(await disabledAtOf(cy.user.id)).toBeNull();

    expect((await as(or, "POST", `/api/users/${cy.user.id}/disable`)).statusCode).toBe(200);
    await expect(h.app.userAdmin.enable(al.user.id, cy.user.id)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    expect(await disabledAtOf(cy.user.id)).not.toBeNull();
  });

  test("enable deletes a session row that raced the disable", async () => {
    expect((await as(or, "POST", `/api/users/${al.user.id}/disable`)).statusCode).toBe(200);
    // A sign-in whose session.create.before ran before the disable committed inserts after its DELETE.
    await h.db.insert(schema.sessions).values({
      id: "raced",
      token: "raced-token",
      userId: al.user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(Date.now() + 1000),
      updatedAt: new Date(),
    });
    expect((await as(or, "POST", `/api/users/${al.user.id}/enable`)).statusCode).toBe(204);
    const left = await h.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, al.user.id));
    expect(left).toEqual([]);
    // Enabling an enabled user signs nobody out.
    expect((await as(or, "POST", `/api/users/${or.user.id}/enable`)).statusCode).toBe(204);
    expect(await meStatus({ cookie: or.cookie })).toBe(200);
  });

  test("an unknown user is 404", async () => {
    expect((await as(or, "POST", "/api/users/nope/disable")).statusCode).toBe(404);
    expect((await as(or, "POST", "/api/users/nope/enable")).statusCode).toBe(404);
  });

  test("two admins disabling each other concurrently: one succeeds, the other gets last_enabled_user", async () => {
    // Hold the enabled users' row locks so both disables queue on them, then release.
    const waiting = async () =>
      (
        await h.sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`
      )[0]?.n ?? 0;
    let both: Promise<Awaited<ReturnType<typeof as>>[]> | undefined;
    await h.sql.begin(async (tx) => {
      await tx`select id from users where disabled_at is null order by id for update`;
      both = Promise.all([
        as(or, "POST", `/api/users/${al.user.id}/disable`),
        as(al, "POST", `/api/users/${or.user.id}/disable`),
      ]);
      // Each iteration is a real round trip to Postgres, not a timer; bounded so a disable that fails
      // before locking reports its cause instead of the test timeout.
      let settled = false;
      void both.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let i = 0; (await waiting()) < 2; i++) {
        if (settled || i >= 2000) throw new Error("disables never queued on the user locks");
      }
      // Committing releases the locks; the disables then proceed.
    });
    const results = await (both as NonNullable<typeof both>);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      error: { code: "last_enabled_user" },
    });
    const enabled = await h.db.select().from(schema.users);
    expect(enabled.filter((u) => u.disabledAt === null)).toHaveLength(1);
  });
});

test("GET /api/users lists every user with disabledAt", async () => {
  await as(or, "POST", `/api/users/${al.user.id}/disable`);
  const res = await as(or, "GET", "/api/users");
  expect(res.statusCode).toBe(200);
  const { users } = res.json() as { users: UserAdminItem[] };
  expect(users.map((u) => u.handle).sort()).toEqual(["al", "or"]);
  expect(users.find((u) => u.handle === "or")).toEqual({
    id: or.user.id,
    ref: or.user.ref,
    name: or.input.name,
    handle: "or",
    email: or.input.email,
    createdAt: expect.any(String),
    disabledAt: null,
  });
  expect(users.find((u) => u.handle === "al")?.disabledAt).toEqual(expect.any(String));
});

test.each([
  ["GET", "/api/users"],
  ["POST", "/api/users/x/disable"],
  ["POST", "/api/users/x/enable"],
] as const)("%s %s: no session and an agent token get 401", async (method, url) => {
  expect((await h.app.inject({ method, url })).statusCode).toBe(401);
  const agent = await h.seedAgent({ slug: "lead" });
  const { token } = h.app.agentTokens.mint(agent.id);
  const res = await h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(401);
});

describe("disabledAt can't be set by the user (V2)", () => {
  test("a sign-up body with disabledAt does not store it", async () => {
    let created: Awaited<ReturnType<typeof signUp>> | undefined;
    try {
      created = await signUp(h.app, {
        handle: "eve",
        disabledAt: "2026-01-01T00:00:00Z",
      } as never);
    } catch {
      // Rejected outright (FIELD_NOT_ALLOWED) is fine too.
    }
    const eve = (await principalsByHandles(h.db, ["eve"])).get("eve");
    const rows = eve
      ? await h.db.select().from(schema.users).where(eq(schema.users.id, eve.id))
      : [];
    expect(rows.every((r) => r.disabledAt === null)).toBe(true);
    if (created) expect(await meStatus({ cookie: created.cookie })).toBe(200);
  });

  test("update-user with disabledAt does not store it", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers: { cookie: al.cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: { disabledAt: "2026-01-01T00:00:00Z" },
    });
    expect(res.statusCode).not.toBe(500);
    expect(await disabledAtOf(al.user.id)).toBeNull();
    expect(await meStatus({ cookie: al.cookie })).toBe(200);
  });
});

describe("open sockets", () => {
  let url: string;
  beforeEach(async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    url = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/api/ws`;
  });

  const open = (headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; frames: ServerMessage[] }>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const frames: ServerMessage[] = [];
      ws.on("message", (d) => {
        frames.push(JSON.parse(String(d)) as ServerMessage);
        if (frames.length === 1) resolve({ ws, frames });
      });
      ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.once("error", reject);
    });

  test("the disabled user's socket closes with 1008 and gets no further agent_status; others stay open", async () => {
    const mine = await open({ cookie: al.cookie, origin: TEST_ORIGIN });
    const bearer = await open({ authorization: `Bearer ${al.token}` });
    const theirs = await open({ cookie: or.cookie, origin: TEST_ORIGIN });
    const closed = (ws: WebSocket) =>
      new Promise<{ code: number; reason: string }>((r) =>
        ws.once("close", (code, reason) => r({ code, reason: String(reason) })),
      );
    const mineClosed = closed(mine.ws);
    const bearerClosed = closed(bearer.ws);

    expect((await as(or, "POST", `/api/users/${al.user.id}/disable`)).statusCode).toBe(200);
    const status = {
      type: "agent_status",
      agent: "dev",
    } as unknown as ServerMessage;
    h.app.bus.publishAll(status);

    expect(await mineClosed).toEqual({ code: 1008, reason: "user disabled" });
    expect(await bearerClosed).toEqual({ code: 1008, reason: "user disabled" });
    expect(mine.frames.some((f) => f.type === "agent_status")).toBe(false);
    expect(bearer.frames.some((f) => f.type === "agent_status")).toBe(false);

    // The other user's socket still receives the broadcast.
    const pong = new Promise<unknown>((r) =>
      theirs.ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.type === "pong") r(m);
      }),
    );
    theirs.ws.send(JSON.stringify({ type: "ping" }));
    await pong;
    expect(theirs.frames.some((f) => f.type === "agent_status")).toBe(true);
    theirs.ws.close();
  });

  test("a socket whose upgrade raced the disable is closed once its closer is registered", async () => {
    // The disable commits after getUser read the session (simulated: getSession still sees al enabled),
    // so closeUser ran before this socket registered its closer.
    await h.db
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, al.user.id));
    const api = h.app.auth.api;
    const real = api.getSession.bind(api);
    const spy = vi.spyOn(api, "getSession").mockImplementation((async (o: never) => {
      const s = (await real(o)) as { user: { disabledAt?: unknown } } | null;
      if (s) s.user.disabledAt = null;
      return s;
    }) as never);
    try {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${al.token}` } });
      const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        ws.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`status ${res.statusCode}`)),
        );
      });
      expect(closed).toEqual({ code: 1008, reason: "user disabled" });
    } finally {
      spy.mockRestore();
    }
  });

  test("a WS upgrade with the old token is 401", async () => {
    await as(or, "POST", `/api/users/${al.user.id}/disable`);
    await expect(open({ authorization: `Bearer ${al.token}` })).rejects.toThrow("status 401");
    await expect(open({ cookie: al.cookie, origin: TEST_ORIGIN })).rejects.toThrow("status 401");
  });
});

test("EventBus: closeUser calls only that user's registered closers; unregister removes one", () => {
  const bus = h.app.bus;
  const calls: string[] = [];
  const offA1 = bus.onUserClose("a", () => calls.push("a1"));
  bus.onUserClose("a", () => calls.push("a2"));
  bus.onUserClose("b", () => calls.push("b"));
  offA1();
  bus.closeUser("a");
  expect(calls).toEqual(["a2"]);
  bus.closeUser("nobody");
  expect(calls).toEqual(["a2"]);
});
