import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claimTestHandle } from "../test/handles.ts";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";
import { handleSignUp } from "./sign-up-gate.ts";

/**
 * S10 §9.3 (F2), AC5: invite-only sign-up, checked in the /api/auth/* catch-all on the normalized path,
 * with an AsyncLocalStorage flag that user.create.before requires. Driven over a real listener: `inject`
 * and `fetch` both normalize dot segments themselves, so raw paths go through node:http.
 */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let port: number;

beforeEach(async () => {
  h = await makeTestApp();
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  port = (h.app.server.address() as AddressInfo).port;
});
afterEach(() => h.close());

interface Raw {
  status: number;
  body: unknown;
}

/** POST with the path sent byte for byte (no client-side URL normalization). */
function rawPost(path: string, payload: unknown): Promise<Raw> {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

let n = 0;
const person = (extra: Record<string, unknown> = {}) => {
  n += 1;
  return {
    name: `Gate ${n}`,
    handle: `gate-${n}`,
    email: `gate-${n}-${Date.now()}@example.com`,
    password: "password123",
    ...extra,
  };
};
const SIGN_UP = "/api/auth/sign-up/email";
const userCount = async () => (await h.db.select({ c: count() }).from(schema.users))[0]?.c ?? 0;
const tokenOf = (link: string) => new URL(link).searchParams.get("invite") ?? "";

const REQUIRED = {
  error: {
    code: "invite_required",
    message: "Sign-up needs an invite link from a member of this factory.",
  },
};
const INVALID = {
  error: {
    code: "invite_invalid",
    message: "This invite link isn't valid anymore. Ask a member of this factory for a new one.",
  },
};

describe("bootstrap", () => {
  test("with zero users, sign-up without an invite succeeds and publishes users_changed", async () => {
    const seen: ServerMessage[] = [];
    h.app.bus.subscribeAll((m) => seen.push(m));
    const res = await rawPost(SIGN_UP, person());
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
    expect(seen).toEqual([{ type: "users_changed" }]);
  });

  test("two concurrent first sign-ups: exactly one succeeds, the other gets invite_required", async () => {
    const [a, b] = await Promise.all([rawPost(SIGN_UP, person()), rawPost(SIGN_UP, person())]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect([a, b].find((r) => r.status === 403)?.body).toEqual(REQUIRED);
    expect(await userCount()).toBe(1);
  });
});

describe("with one user", () => {
  let ownerId: string;
  beforeEach(async () => {
    ownerId = (await signUp(h.app, { handle: "or" })).user.id;
  });
  const newInvite = async () => {
    const { invite, link } = await h.app.invites.create(ownerId);
    return { id: invite.id, token: tokenOf(link) };
  };

  test("no invite is invite_required; a valid one works once and is marked used by the new user", async () => {
    const none = await rawPost(SIGN_UP, person());
    expect(none.status).toBe(403);
    expect(none.body).toEqual(REQUIRED);
    expect(await userCount()).toBe(1);

    const inv = await newInvite();
    const ok = await rawPost(SIGN_UP, person({ invite: inv.token }));
    expect(ok.status).toBe(200);
    const newId = (ok.body as { user: { id: string } }).user.id;
    const [row] = await h.db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    expect(row?.usedBy).toBe(newId);
    expect(row?.usedAt).not.toBeNull();

    const again = await rawPost(SIGN_UP, person({ invite: inv.token }));
    expect(again.status).toBe(403);
    expect(again.body).toEqual(INVALID);
    expect(await userCount()).toBe(2);
  });

  test("expired, revoked and unknown invites all give the same invite_invalid body", async () => {
    const expired = await newInvite();
    await h.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invites.id, expired.id));
    const revoked = await newInvite();
    await h.app.invites.revoke(revoked.id);
    for (const token of [expired.token, revoked.token, "unknown-token"]) {
      const res = await rawPost(SIGN_UP, person({ invite: token }));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID);
    }
    expect(await userCount()).toBe(1);
  });

  test('an empty invite counts as missing: invite_required, as sign-up-state says "missing"', async () => {
    const res = await rawPost(SIGN_UP, person({ invite: "" }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual(REQUIRED);
  });

  test("a successful sign-up publishes users_changed; a refused one doesn't", async () => {
    const seen: ServerMessage[] = [];
    h.app.bus.subscribeAll((m) => seen.push(m));
    await rawPost(SIGN_UP, person());
    expect(seen).toEqual([]);
    const inv = await newInvite();
    seen.length = 0;
    expect((await rawPost(SIGN_UP, person({ invite: inv.token }))).status).toBe(200);
    expect(seen).toEqual([{ type: "users_changed" }]);
  });

  describe("after better-auth's 2xx", () => {
    const fakeAuth = (body: unknown, create?: Record<string, string>) => ({
      handler: async () => {
        if (create) {
          await claimTestHandle(h.db, create.handle as string, "user");
          await h.db.insert(schema.users).values({
            id: create.id as string,
            name: "Fake",
            handle: create.handle as string,
            email: create.email as string,
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        return Response.json(body);
      },
    });
    const deps = (auth: ReturnType<typeof fakeAuth>) => {
      const log = { error: vi.fn() };
      return { log, d: { db: h.db, invites: h.app.invites, auth, bus: h.app.bus, log } };
    };
    const req = () => new Request(`${h.app.config.publicUrl}${SIGN_UP}`, { method: "POST" });

    test("a body without user.id: the user is found by email and the invite marked used", async () => {
      const inv = await newInvite();
      const p = person({ invite: inv.token });
      const { d, log } = deps(fakeAuth({}, { id: "fake-1", handle: "fake-1", email: p.email }));
      const res = await handleSignUp(d as never, req(), { ...p, email: p.email.toUpperCase() });
      expect(res.status).toBe(200);
      const [row] = await h.db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
      expect(row?.usedBy).toBe("fake-1");
      expect(log.error).not.toHaveBeenCalled();
    });

    test("markUsed returning false is logged at error level", async () => {
      const inv = await newInvite();
      const { d, log } = deps(fakeAuth({ user: { id: ownerId } }));
      const spy = vi.spyOn(h.app.invites, "markUsed").mockResolvedValue(false);
      try {
        const res = await handleSignUp(d as never, req(), person({ invite: inv.token }));
        expect(res.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ inviteId: inv.id }),
        expect.stringContaining("already marked used"),
      );
    });
  });

  test("a failed sign-up (duplicate email) leaves the invite unused", async () => {
    const inv = await newInvite();
    const [owner] = await h.db.select().from(schema.users).where(eq(schema.users.id, ownerId));
    const dup = await rawPost(SIGN_UP, person({ email: owner?.email, invite: inv.token }));
    expect(dup.status).not.toBe(200);
    expect(await h.app.invites.check(inv.token)).toEqual({ id: inv.id });
  });

  test("two concurrent sign-ups on one invite: exactly one user is created", async () => {
    const inv = await newInvite();
    const [a, b] = await Promise.all([
      rawPost(SIGN_UP, person({ invite: inv.token })),
      rawPost(SIGN_UP, person({ invite: inv.token })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect([a, b].find((r) => r.status === 403)?.body).toEqual(INVALID);
    expect(await userCount()).toBe(2);
  });

  test.each([
    "/api/auth/./sign-up/email",
    "/api/auth/x/../sign-up/email",
    "/api/auth/%2e/sign-up/email",
    "/api/auth/sign-up/./email",
    "/api/auth/sign-up/email/",
    "//api/auth/sign-up/email",
    "/api/auth//sign-up/email",
    "/API/auth/sign-up/email",
    "/api/auth/sign-up/email?x=1",
    "/api/auth/sign-up/%65mail",
  ])("bypass variant %s without an invite never creates a user", async (path) => {
    const res = await rawPost(path, person());
    expect(res.status).not.toBe(200);
    expect(await userCount()).toBe(1);
  });
});

describe("the user.create.before backstop", () => {
  test("a direct signUpEmail outside the gate is refused, even with zero users", async () => {
    await expect(h.app.auth.api.signUpEmail({ body: person() })).rejects.toMatchObject({
      body: { code: "invite_required" },
    });
    expect(await userCount()).toBe(0);
  });

  test("auth.handler reached without the gate is refused, even with zero users", async () => {
    const res = await h.app.auth.handler(
      new Request(`${h.app.config.publicUrl}${SIGN_UP}`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(person()),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "invite_required" });
    expect(await userCount()).toBe(0);
  });
});

describe("GET /api/auth/sign-up-state", () => {
  const state = async (invite?: string) => {
    const q = invite === undefined ? "" : `?invite=${encodeURIComponent(invite)}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up-state${q}`);
    return {
      status: res.status,
      body: (await res.json()) as { bootstrap: boolean; invite: string },
    };
  };

  test("bootstrap with zero users; valid, invalid and missing with one user; no session needed", async () => {
    expect(await state()).toEqual({ status: 200, body: { bootstrap: true, invite: "missing" } });
    const { user } = await signUp(h.app, { handle: "or" });
    const { invite, link } = await h.app.invites.create(user.id);
    expect(await state(tokenOf(link))).toEqual({
      status: 200,
      body: { bootstrap: false, invite: "valid" },
    });
    expect(await state("nope")).toEqual({
      status: 200,
      body: { bootstrap: false, invite: "invalid" },
    });
    expect(await state()).toEqual({ status: 200, body: { bootstrap: false, invite: "missing" } });
    await h.app.invites.revoke(invite.id);
    expect((await state(tokenOf(link))).body.invite).toBe("invalid");
  });
});
