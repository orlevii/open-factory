import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { EventStore } from "../agents/event-store.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { ExpiryCheck } from "./expiry-check.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
let now = new Date("2027-11-01T00:00:00Z");
const published: { userId: string; type: string }[] = [];
const errors: unknown[] = [];
const users = ["u1", "u2"];

const check = () =>
  new ExpiryCheck({
    db: t.db,
    store,
    bus: { publishToUser: (userId, m) => void published.push({ userId, type: m.type }) },
    zone: "UTC",
    now: () => now,
    log: { error: (o: unknown) => void errors.push(o) } as never,
  });

beforeAll(async () => {
  t = await createTestDb();
  store = new EventStore(t.db);
  for (const [i, id] of users.entries()) {
    await claimTestHandleSql(t.sql, `h${i}`, "user");
    await t.sql`insert into users (id,name,email,handle) values (${id},${id},${`${id}@x.io`},${`h${i}`})`;
  }
});
afterAll(() => t.close());
beforeEach(async () => {
  now = new Date("2027-11-01T00:00:00Z");
  published.length = 0;
  errors.length = 0;
  await t.sql`delete from credentials`;
});

async function addCredential(name: string, expiresAt: Date | null) {
  await t.db.insert(schema.credentials).values({
    id: `c-${name}`,
    name,
    kind: "oauth_token",
    valueEnc: Buffer.from([0]),
    expiresAt,
  });
}
const items = async (u = "u1") =>
  (await store.inboxPage(u)).items.filter((i) => i.kind === "credential");
const count = async () =>
  (await t.sql`select count(*)::int as n from messages where subject_credential_id is not null`)[0]
    ?.n;

test("notifies once per user within 14 days, never for null expires_at", async () => {
  await addCredential("work", new Date("2027-11-12T00:00:00Z"));
  await addCredential("pasted", null);
  await addCredential("far", new Date("2028-01-01T00:00:00Z"));
  const c = check();
  await c.run();
  await c.run();
  for (const u of users) {
    const got = await items(u);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "credential",
      preview: "work expires on 2027-11-12.",
      from: { kind: "factory", name: "factory" },
      link: { kind: "credential", name: "work" },
      credential: { name: "work", current: true, expiresAt: "2027-11-12T00:00:00.000Z" },
    });
    expect(got[0]).not.toHaveProperty("about");
  }
  expect(await count()).toBe(1);
});

test("two concurrent runs make one message", async () => {
  await addCredential("work", new Date("2027-11-05T00:00:00Z"));
  await Promise.all([check().run(), check().run()]);
  expect(await count()).toBe(1);
  expect(await items()).toHaveLength(1);
});

test("an already expired credential says expired on", async () => {
  await addCredential("old", new Date("2027-10-20T00:00:00Z"));
  await check().run();
  expect((await items())[0]?.preview).toBe("old expired on 2027-10-20.");
});

test("replace re-arms (current false, next run within 14 days notifies again)", async () => {
  await addCredential("work", new Date("2027-11-05T00:00:00Z"));
  await check().run();
  await t.db
    .update(schema.credentials)
    .set({ expiryNotifiedAt: null, expiresAt: new Date("2027-11-10T00:00:00Z") })
    .where(eq(schema.credentials.name, "work"));
  const stale = await items();
  expect(stale[0]?.credential?.current).toBe(false);
  now = new Date("2027-11-02T00:00:00Z");
  await check().run();
  const got = await items();
  expect(got).toHaveLength(2);
  expect(got.map((i) => i.credential?.current).sort()).toEqual([false, true]);
});

test("deleting the credential cascades the notice", async () => {
  await addCredential("work", new Date("2027-11-05T00:00:00Z"));
  await check().run();
  await t.sql`delete from credentials where name = 'work'`;
  expect(await count()).toBe(0);
  expect(await items()).toHaveLength(0);
});

test("publishes inbox_changed to each addressee after commit", async () => {
  await addCredential("work", new Date("2027-11-05T00:00:00Z"));
  await check().run();
  expect(published.map((p) => p.userId).sort()).toEqual(users);
  expect(published.every((p) => p.type === "inbox_changed")).toBe(true);
});

test("a failing run is logged, never thrown", async () => {
  const c = new ExpiryCheck({
    db: t.db,
    store: { createHumanMessage: async () => Promise.reject(new Error("x")) } as never,
    bus: { publishToUser: () => {} },
    zone: "UTC",
    now: () => now,
    log: { error: (o: unknown) => void errors.push(o) } as never,
  });
  await addCredential("work", new Date("2027-11-05T00:00:00Z"));
  await expect(c.run()).resolves.toBeUndefined();
  expect(errors).toHaveLength(1);
});
