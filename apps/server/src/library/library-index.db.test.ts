// CI only: needs Postgres (createTestDb).
import { randomUUID } from "node:crypto";
import { schema } from "@open-factory/db";
import type { ConfigDoc } from "@open-factory/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { seedTestPrincipal, seedTestUser, testManagerUserId } from "../test/principals.ts";
import { LibraryIndex } from "./library-index.ts";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  tdb = await createTestDb();
  await seedTestUser(tdb.db, "or");
});
afterAll(async () => {
  await tdb.close();
});

test("the database store reads live sources and live agents, and usedBy counts them", async () => {
  const { db } = tdb;
  const base = {
    kind: "github" as const,
    repo: "acme/x",
    subpath: "",
    branch: "main",
    commit: "a".repeat(40),
    state: "ready" as const,
    startedAt: new Date(),
    addedById: "u-or",
    addedAt: new Date(),
  };
  await db.insert(schema.skillSources).values([
    { ...base, skills: ["tdd"] },
    { ...base, skills: ["gone"], deletedAt: new Date() },
  ]);
  const [cred] = await db
    .insert(schema.credentials)
    .values({ id: randomUUID(), name: "c", kind: "api_key", valueEnc: Buffer.from("x") })
    .returning();
  const agent = async (handle: string, o: { archivedAt?: Date; config?: object } = {}) => {
    const principal = await seedTestPrincipal(db, "agent", handle);
    await db.insert(schema.agents).values({
      id: principal.id,
      displayName: handle,
      template: "dev",
      config: o.config ?? {},
      runtime: "local",
      credentialId: cred?.id,
      reportsTo: await testManagerUserId(db),
      archivedAt: o.archivedAt,
    });
  };
  await agent("ann");
  await agent("bob", { archivedAt: new Date() });
  await agent("cy", { config: { template: { skills: ["other"] } } });

  const doc = { template: { skills: ["tdd"] }, settings: {}, mcp: { mcpServers: {} } } as ConfigDoc;
  const idx = new LibraryIndex({
    db,
    hostClaudeDir: "/nonexistent",
    factoryHome: "/nonexistent",
    templates: () => ({
      names: async () => ["dev"],
      localSkillsOf: async () => [],
      lastValid: async () => doc,
    }),
  });
  // An agent uses the union of its template's skills and its own: cy lists "other" itself and inherits "tdd".
  expect(await idx.usedBy("tdd")).toEqual({ templates: ["dev"], agents: ["ann", "cy"] });
  expect(await idx.usedBy("other")).toEqual({ templates: [], agents: ["cy"] });
  const groups = await idx.skills();
  expect(groups.map((g) => g.kind)).toEqual(["host", "source", "unknown"]);
  expect(groups[2]?.skills.map((s) => s.name)).toEqual(["other"]);
});
