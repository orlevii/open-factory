// CI only: needs Postgres (createTestDb).
import type { MarketplaceRow } from "@open-factory/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { dbMarketplacesStore } from "./marketplaces-service.ts";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.close();
});

const row = (o: Partial<MarketplaceRow>): MarketplaceRow => ({
  name: "acme",
  source: { source: "github", repo: "acme/x" },
  branch: "main",
  commit: "a".repeat(40),
  committedAt: null,
  subject: null,
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  tags: {},
  state: "ready",
  startedAt: new Date(),
  addedBy: "@or",
  addedAt: new Date(),
  deletedAt: null,
  ...o,
});

test("the database store inserts, updates, lists oldest first (soft-deleted included) and deletes", async () => {
  const store = dbMarketplacesStore(tdb.db);
  const older = row({ name: "older", addedAt: new Date(1000) });
  const newer = row({ name: "newer", addedAt: new Date(2000) });
  await store.insert(newer);
  await store.insert(older);
  const gone = new Date(3000);
  const updated = await store.update("newer", { deletedAt: gone, tags: { v1: "b".repeat(40) } });
  expect(updated).toMatchObject({ name: "newer", deletedAt: gone, tags: { v1: "b".repeat(40) } });
  expect((await store.all()).map((r) => r.name)).toEqual(["older", "newer"]);
  expect(await store.update("missing", { subject: "x" })).toBeUndefined();
  await store.delete("older");
  expect((await store.all()).map((r) => r.name)).toEqual(["newer"]);
});

test("a marketplace name is unique", async () => {
  const store = dbMarketplacesStore(tdb.db);
  await store.insert(row({ name: "dup" }));
  await expect(store.insert(row({ name: "dup" }))).rejects.toThrow();
});
