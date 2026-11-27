import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "../client.ts";
import { createMigratedTestDatabase } from "../testing.ts";
import { skillSources } from "./library.ts";
import { principals } from "./principals.ts";

let tdb: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
let h: ReturnType<typeof createDb>;
beforeAll(async () => {
  tdb = await createMigratedTestDatabase();
  h = createDb(tdb.url);
});
afterAll(async () => {
  await h.close();
  await tdb.release();
});

test("a GitHub skill source reads back with its picked skills and pinned trees", async () => {
  const addedAt = new Date("2026-11-24T10:00:00Z");
  const [principal] = await h.db
    .insert(principals)
    .values({ id: "p-or", kind: "human", handle: "or", ref: "0r000000" })
    .returning();
  if (!principal) throw new Error("seed failed");
  const [inserted] = await h.db
    .insert(skillSources)
    .values({
      kind: "github",
      repo: "acme/skills",
      subpath: "",
      branch: "main",
      commit: "a".repeat(40),
      committedAt: addedAt,
      subject: "Add research skill",
      trees: { a: "b".repeat(40) },
      skills: ["a"],
      state: "ready",
      startedAt: addedAt,
      addedById: principal.id,
      addedAt,
    })
    .returning();
  const [row] = await h.db.select().from(skillSources);
  expect(row).toEqual(inserted);
  expect(row).toMatchObject({
    kind: "github",
    repo: "acme/skills",
    subpath: "",
    branch: "main",
    commit: "a".repeat(40),
    trees: { a: "b".repeat(40) },
    skills: ["a"],
    state: "ready",
    path: null,
    updateCommit: null,
    deletedAt: null,
  });
});
