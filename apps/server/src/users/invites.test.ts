import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";
import { hashToken, INVITE_TTL_MS } from "./invites.ts";

/** S10 §9.2: invite tokens are random, stored hashed, single use, revocable, expiring. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let userId: string;
let now = new Date("2026-11-20T10:00:00Z");
const tokenOf = (link: string) => new URL(link).searchParams.get("invite") ?? "";

beforeEach(async () => {
  now = new Date("2026-11-20T10:00:00Z");
  h = await makeTestApp({ clock: () => now });
  userId = (await signUp(h.app, { handle: "or" })).user.id;
});
afterEach(() => h.close());

test("create stores only the hash and returns the link once", async () => {
  const { invite, link } = await h.app.invites.create(userId);
  const token = tokenOf(link);
  expect(link).toBe(`${h.app.config.publicUrl}/sign-up?invite=${token}`);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const [row] = await h.db.select().from(schema.invites).where(eq(schema.invites.id, invite.id));
  expect(row?.tokenHash).toBe(hashToken(token));
  expect(row?.tokenHash).not.toBe(token);
  expect(invite.expiresAt).toBe(new Date(now.getTime() + INVITE_TTL_MS).toISOString());
  expect(invite.createdBy).toBe(userId);
});

test("check is null for unknown, used, revoked and expired invites", async () => {
  const { invite, link } = await h.app.invites.create(userId);
  const token = tokenOf(link);
  expect(await h.app.invites.check("nope")).toBeNull();
  expect(await h.app.invites.check(token)).toEqual({ id: invite.id });
  await h.app.invites.revoke(invite.id);
  expect(await h.app.invites.check(token)).toBeNull();
  await h.app.invites.restore(invite.id);
  expect(await h.app.invites.check(token)).toEqual({ id: invite.id });
  now = new Date(now.getTime() + INVITE_TTL_MS);
  expect(await h.app.invites.check(token)).toBeNull();
  now = new Date("2026-11-20T10:00:00Z");
  expect(await h.app.invites.markUsed(invite.id, userId)).toBe(true);
  expect(await h.app.invites.check(token)).toBeNull();
});

test("restore after expiry is 409 invite_expired, after use 409 invite_used", async () => {
  const a = await h.app.invites.create(userId);
  await h.app.invites.revoke(a.invite.id);
  now = new Date(now.getTime() + INVITE_TTL_MS + 1);
  await expect(h.app.invites.restore(a.invite.id)).rejects.toMatchObject({
    status: 409,
    code: "invite_expired",
  });
  now = new Date("2026-11-20T10:00:00Z");
  const b = await h.app.invites.create(userId);
  await h.app.invites.markUsed(b.invite.id, userId);
  await expect(h.app.invites.restore(b.invite.id)).rejects.toMatchObject({
    status: 409,
    code: "invite_used",
  });
});

test("markUsed twice: the second returns false", async () => {
  const { invite } = await h.app.invites.create(userId);
  expect(await h.app.invites.markUsed(invite.id, userId)).toBe(true);
  expect(await h.app.invites.markUsed(invite.id, userId)).toBe(false);
});

test("listPending leaves out used, revoked and expired", async () => {
  const keep = await h.app.invites.create(userId);
  const used = await h.app.invites.create(userId);
  const revoked = await h.app.invites.create(userId);
  await h.app.invites.markUsed(used.invite.id, userId);
  await h.app.invites.revoke(revoked.invite.id);
  expect((await h.app.invites.listPending()).map((i) => i.id)).toEqual([keep.invite.id]);
  now = new Date(now.getTime() + INVITE_TTL_MS);
  expect(await h.app.invites.listPending()).toEqual([]);
});

test("create, revoke and restore publish users_changed", async () => {
  const seen: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => seen.push(m));
  const { invite } = await h.app.invites.create(userId);
  await h.app.invites.revoke(invite.id);
  await h.app.invites.restore(invite.id);
  expect(seen).toEqual([
    { type: "users_changed" },
    { type: "users_changed" },
    { type: "users_changed" },
  ]);
});
