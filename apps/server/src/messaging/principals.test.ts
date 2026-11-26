import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
import { resolveName } from "./principals.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  await t.sql.unsafe(principalSql("u2", "human", "off"));
  await t.sql`insert into users (id, name, email, disabled_at) values ('u2','Off','off@x.io', now())`;
  await insertAgent(t.sql, { id: "dev", slug: "dev" });
  await insertAgent(t.sql, { id: "gone", slug: "gone", archived: true });
});
afterAll(async () => t.close());

test.each([
  ["#ops", "channel"],
  ["@humans", "reserved"],
  ["humans", "reserved"],
  ["me", "reserved"],
  ["@nobody", "none"],
  ["@dev", "agent"],
  [" or ", "user"],
  ["gone", "agent"],
])("resolveName(%s) is %s", async (raw, kind) => {
  expect((await resolveName(t.db, raw)).kind).toBe(kind);
});
test("resolveName reports a disabled user", async () => {
  expect(await resolveName(t.db, "off")).toMatchObject({ kind: "user", disabled: true });
  expect(await resolveName(t.db, "or")).toMatchObject({ kind: "user", disabled: false });
});
