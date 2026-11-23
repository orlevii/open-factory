import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { claimTestHandleSql } from "../test/handles.ts";
import { createTestDb } from "../test/helpers.ts";
import { isNameTaken, resolveName } from "./principals.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await claimTestHandleSql(t.sql, "or", "user");
  await t.sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or')`;
  await insertAgent(t.sql, { id: "dev", slug: "dev" });
  await insertAgent(t.sql, { id: "gone", slug: "gone", archived: true });
});
afterAll(async () => t.close());

test("one namespace: slugs and handles collide; @ is optional; reserved; ambiguous", async () => {
  expect(await isNameTaken(t.db, "or")).toBe("user");
  expect(await isNameTaken(t.db, "dev")).toBe("agent");
  expect(await isNameTaken(t.db, "gone")).toBe("agent"); // archived agents keep their slug
  expect(await isNameTaken(t.db, "system")).toBe("reserved");
  expect(await isNameTaken(t.db, "fresh")).toBe(false);
  expect((await resolveName(t.db, "@dev")).kind).toBe("agent");
  expect((await resolveName(t.db, " or ")).kind).toBe("user");
  expect((await resolveName(t.db, "@humans")).kind).toBe("humans");
  expect((await resolveName(t.db, "me")).kind).toBe("reserved");
  expect((await resolveName(t.db, "nobody")).kind).toBe("none");
  await claimTestHandleSql(t.sql, "dev", "user");
  await t.sql`insert into users (id,name,email,handle) values ('u9','Dup','d@x.io','dev')`; // a dev-DB collision
  expect((await resolveName(t.db, "dev")).kind).toBe("ambiguous");
});
