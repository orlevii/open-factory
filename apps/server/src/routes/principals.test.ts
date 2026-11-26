import { schema } from "@open-factory/db";
import type { PrincipalsResponse } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;

beforeEach(async () => {
  h = await makeTestApp();
  or = await signUp(h.app, { handle: "or" });
});
afterEach(() => h.close());

const get = (url: string) => h.app.inject({ method: "GET", url, headers: { cookie: or.cookie } });
const list = async (url: string) => ((await get(url)).json() as PrincipalsResponse).principals;

test("GET /api/principals without a session is 401", async () => {
  expect((await h.app.inject({ method: "GET", url: "/api/principals" })).statusCode).toBe(401);
});

test("GET /api/principals lists every agent and human with the state a chip shows", async () => {
  const live = await h.seedAgent({ slug: "dev" });
  const archived = await h.seedAgent({ slug: "old" });
  const terminated = await h.seedAgent({ slug: "gone" });
  await h.app.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.id, archived.id));
  await h.app.db
    .update(schema.agents)
    .set({
      kind: "ephemeral",
      terminatedAt: new Date(),
      terminatedBy: "or",
      reportsTo: live.id,
      reportsToUser: null,
      color: 3,
    })
    .where(eq(schema.agents.id, terminated.id));
  const other = await signUp(h.app, { handle: "pat" });
  await h.app.db
    .update(schema.users)
    .set({ disabledAt: new Date() })
    .where(eq(schema.users.id, other.user.id));

  const byHandle = new Map((await list("/api/principals")).map((p) => [p.handle, p]));
  expect(byHandle.get("dev")).toMatchObject({
    id: live.id,
    kind: "agent",
    name: "Test agent",
    state: "live",
    avatar: { template: "test", avatarVersion: null, color: null },
  });
  expect(byHandle.get("old")?.state).toBe("archived");
  expect(byHandle.get("gone")).toMatchObject({ state: "terminated", avatar: { color: 3 } });
  expect(byHandle.get("or")).toMatchObject({ kind: "human", state: "live", avatar: null });
  expect(byHandle.get("pat")?.state).toBe("disabled");
});

test("GET /api/principals?refs= returns only those refs, case-insensitively", async () => {
  const dev = await h.seedAgent({ slug: "dev" });
  await h.seedAgent({ slug: "other" });
  const ref = (
    await h.app.db
      .select({ ref: schema.principals.ref })
      .from(schema.principals)
      .where(eq(schema.principals.id, dev.id))
  )[0]?.ref as string;

  const got = await list(`/api/principals?refs=${ref.toUpperCase()},zzzzzzzz,nope`);
  expect(got.map((p) => p.handle)).toEqual(["dev"]);
  expect(await list("/api/principals?refs=")).toEqual([]);
});

test("GET /api/principals?refs= with more than 100 refs is 400", async () => {
  const refs = Array.from({ length: 101 }, () => "abcd2345").join(",");
  expect((await get(`/api/principals?refs=${refs}`)).statusCode).toBe(400);
});
