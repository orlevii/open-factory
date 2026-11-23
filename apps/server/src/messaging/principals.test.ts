import { handleSchema, slugSchema } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { claimHandle, handleKind, resolveName } from "./principals.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or')`;
  await claimTestHandleSql(t.sql, "off", "user");
  await t.sql`insert into users (id,name,email,handle,disabled_at) values ('u2','Off','off@x.io','off', now())`;
  await insertAgent(t.sql, { id: "dev", slug: "dev" });
  await insertAgent(t.sql, { id: "gone", slug: "gone", archived: true });
});
afterAll(async () => t.close());

test("claim, then the same claim again by the same kind while unreferenced is a reclaim", async () => {
  expect(await claimHandle(t.db, "ada", "user")).toBe(true);
  expect(await claimHandle(t.db, "ada", "user")).toBe(true); // orphan reclaimed
});
test("an agent never reclaims a user orphan", async () => {
  await claimHandle(t.db, "bob", "user");
  expect(await claimHandle(t.db, "bob", "agent")).toBe(false);
});
test("a referenced claim is taken", async () => {
  expect(await claimHandle(t.db, "or", "user")).toBe(false);
  expect(await claimHandle(t.db, "dev", "agent")).toBe(false);
  expect(await claimHandle(t.db, "gone", "agent")).toBe(false); // archived agents keep their slug
});
test("handleKind reads the claim", async () => {
  expect(await handleKind(t.db, "or")).toBe("user");
  expect(await handleKind(t.db, "dev")).toBe("agent");
  expect(await handleKind(t.db, "never-claimed")).toBeUndefined();
});
test("a reserved name is refused by validation before any claim", () => {
  expect(handleSchema.safeParse("humans").success).toBe(false);
  expect(slugSchema.safeParse("factory").success).toBe(false);
});
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
