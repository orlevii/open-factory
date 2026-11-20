import type { InviteItem, ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** S10 §9.2, §13: invite REST, human session only. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
const clock = new Date("2026-11-20T10:00:00Z");

beforeEach(async () => {
  h = await makeTestApp({ clock: () => clock });
  or = await signUp(h.app, { handle: "or" });
});
afterEach(() => h.close());

const call = (method: "GET" | "POST", url: string) =>
  h.app.inject({ method, url, headers: { cookie: or.cookie, origin: "http://localhost:3000" } });

test("POST creates (201 with link), GET lists without tokens, revoke and restore publish users_changed", async () => {
  const seen: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => seen.push(m));
  const created = await call("POST", "/api/invites");
  expect(created.statusCode).toBe(201);
  const { invite, link } = created.json() as { invite: InviteItem; link: string };
  expect(link).toContain("/sign-up?invite=");
  expect(invite.createdBy).toBe(or.user.id);

  const listed = await call("GET", "/api/invites");
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual({ invites: [invite] });
  expect(listed.body).not.toContain(new URL(link).searchParams.get("invite"));

  expect((await call("POST", `/api/invites/${invite.id}/revoke`)).statusCode).toBe(204);
  expect((await call("GET", "/api/invites")).json()).toEqual({ invites: [] });
  expect((await call("POST", `/api/invites/${invite.id}/restore`)).statusCode).toBe(204);
  expect((await call("GET", "/api/invites")).json()).toEqual({ invites: [invite] });
  expect(seen.filter((m) => m.type === "users_changed")).toHaveLength(3);
});

test("revoke or restore of an unknown id is 404", async () => {
  expect((await call("POST", "/api/invites/nope/revoke")).statusCode).toBe(404);
  expect((await call("POST", "/api/invites/nope/restore")).statusCode).toBe(404);
});

test.each([
  ["GET", "/api/invites"],
  ["POST", "/api/invites"],
  ["POST", "/api/invites/x/revoke"],
  ["POST", "/api/invites/x/restore"],
] as const)(
  "%s %s needs a human session: no auth and an agent token get 401",
  async (method, url) => {
    expect((await h.app.inject({ method, url })).statusCode).toBe(401);
    const agent = await h.seedAgent({ slug: "lead" });
    const { token } = h.app.agentTokens.mint(agent.id);
    const res = await h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  },
);
