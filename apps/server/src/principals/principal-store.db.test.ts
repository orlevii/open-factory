import { randomUUID } from "node:crypto";
import { refOf } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { seedTestUser } from "../test/principals.ts";
import {
  createPrincipal,
  HandleTakenError,
  principalById,
  principalsByHandles,
  principalsByRefs,
} from "./principal-store.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t.close());

test("a new principal gets a UUID id and the ref derived from it, readable by id, ref and handle", async () => {
  const p = await createPrincipal(t.db, "agent", "reader");
  expect(p.ref).toBe(refOf(p.id));
  expect(await principalById(t.db, p.id)).toEqual(p);
  expect((await principalsByRefs(t.db, [p.ref])).get(p.ref)).toEqual(p);
  expect((await principalsByHandles(t.db, ["reader"])).get("reader")).toEqual(p);
});

test("two principals can't share a handle", async () => {
  await createPrincipal(t.db, "agent", "dev");
  await expect(createPrincipal(t.db, "human", "dev")).rejects.toBeInstanceOf(HandleTakenError);
  expect((await principalsByHandles(t.db, ["dev"])).get("dev")?.kind).toBe("agent");
});

test("a taken handle inside a transaction leaves the transaction usable", async () => {
  await createPrincipal(t.db, "agent", "held");
  const after = await t.db.transaction(async (tx) => {
    await expect(createPrincipal(tx, "agent", "held")).rejects.toBeInstanceOf(HandleTakenError);
    return createPrincipal(tx, "agent", "free-after");
  });
  expect(await principalById(t.db, after.id)).toMatchObject({ handle: "free-after" });
});

test("a ref collision retries with a new id", async () => {
  const first = randomUUID();
  const fresh = randomUUID();
  await t.sql.unsafe(
    `insert into principals (id, kind, handle, ref) values ('squatter', 'agent', 'squatter', '${refOf(first)}')`,
  );
  const ids = [first, fresh];
  const p = await createPrincipal(t.db, "agent", "retrier", () => ids.shift() ?? randomUUID());
  expect(p.id).toBe(fresh);
  expect(p.ref).toBe(refOf(fresh));
});

test("gives up after five ref collisions", async () => {
  const taken = randomUUID();
  await t.sql.unsafe(
    `insert into principals (id, kind, handle, ref) values ('holder', 'agent', 'holder', '${refOf(taken)}')`,
  );
  await expect(createPrincipal(t.db, "agent", "unlucky", () => taken)).rejects.toThrow(
    /unused ref/,
  );
});

test("an agent can't exist without its principal", async () => {
  await t.sql`insert into credentials (id, name, kind, value_enc) values ('c-orphan', 'c', 'oauth_token', ${Buffer.from("x")})`;
  const boss = await seedTestUser(t.db, "boss");
  await expect(
    t.sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, reports_to_user)
          values ('no-principal', 'no-principal', 'X', 't', '{}', 'local', 'c-orphan', ${boss.id})`,
  ).rejects.toMatchObject({ code: "23503" });
});

test("a user can't exist without its principal", async () => {
  await expect(
    t.sql`insert into users (id, name, email) values ('no-principal-u', 'X', 'x@x.io')`,
  ).rejects.toMatchObject({ code: "23503" });
});
