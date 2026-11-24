import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "../client.ts";
import { createMigratedTestDatabase } from "../testing.ts";
import { marketplaces, skillSources } from "./library.ts";

let tdb: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
let h: ReturnType<typeof createDb>;
beforeAll(async () => {
  tdb = await createMigratedTestDatabase();
  h = createDb(tdb.url);
});
afterAll(async () => {
  await h.close();
  await tdb.drop();
});

test("a GitHub skill source reads back with its picked skills and pinned trees", async () => {
  const addedAt = new Date("2026-11-24T10:00:00Z");
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
      addedBy: "or",
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

test("a marketplace reads back with its source, commit and tags", async () => {
  const addedAt = new Date("2026-11-24T10:00:00Z");
  const [inserted] = await h.db
    .insert(marketplaces)
    .values({
      name: "acme",
      source: { source: "github", repo: "acme/plugins" },
      branch: "main",
      commit: "c".repeat(40),
      committedAt: addedAt,
      subject: "Add marker plugin",
      tags: { "v1.0.0": "d".repeat(40) },
      state: "ready",
      startedAt: addedAt,
      addedBy: "or",
      addedAt,
    })
    .returning();
  const [row] = await h.db.select().from(marketplaces);
  expect(row).toEqual(inserted);
  expect(row).toMatchObject({
    name: "acme",
    source: { source: "github", repo: "acme/plugins" },
    commit: "c".repeat(40),
    tags: { "v1.0.0": "d".repeat(40) },
    state: "ready",
    updateCommit: null,
    deletedAt: null,
  });
});

test("a marketplace refuses a state outside adding and ready", async () => {
  const addedAt = new Date("2026-11-24T10:00:00Z");
  const refused = await h.db
    .insert(marketplaces)
    .values({
      name: "bogus",
      source: { source: "directory", path: "/plugins" },
      tags: {},
      // The type forbids it; the table must refuse it too.
      state: "failed" as unknown as "ready",
      startedAt: addedAt,
      addedBy: "or",
      addedAt,
    })
    .then(
      () => null,
      (e: unknown) => e as { cause?: { code?: string } },
    );
  // Postgres check_violation, however the driver words the message.
  expect(refused?.cause?.code).toBe("23514");
});
