// CI only: needs Postgres (createTestDb).
import { randomUUID } from "node:crypto";
import type { SkillSourceRow } from "@open-factory/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { dbSourcesStore } from "./sources-service.ts";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.close();
});

const row = (o: Partial<SkillSourceRow>): SkillSourceRow => ({
  id: randomUUID(),
  kind: "github",
  path: null,
  repo: "acme/x",
  subpath: "",
  branch: "main",
  commit: "a".repeat(40),
  committedAt: null,
  subject: null,
  trees: null,
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  skills: ["tdd"],
  state: "ready",
  startedAt: new Date(),
  addedBy: "@or",
  addedAt: new Date(),
  deletedAt: null,
  ...o,
});

test("the database store inserts, updates, lists oldest first (soft-deleted included) and deletes", async () => {
  const store = dbSourcesStore(tdb.db);
  const older = row({ addedAt: new Date(1000), skills: ["a"] });
  const newer = row({ addedAt: new Date(2000), skills: ["b"] });
  await store.insert(newer);
  await store.insert(older);
  const gone = new Date(3000);
  const updated = await store.update(newer.id, { deletedAt: gone, trees: { b: "t" } });
  expect(updated).toMatchObject({ id: newer.id, deletedAt: gone, trees: { b: "t" } });
  expect((await store.all()).map((r) => r.id)).toEqual([older.id, newer.id]);
  expect(await store.update(randomUUID(), { subject: "x" })).toBeUndefined();
  await store.delete(older.id);
  expect((await store.all()).map((r) => r.id)).toEqual([newer.id]);
});
