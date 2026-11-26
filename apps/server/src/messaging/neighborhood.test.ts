import { afterAll, beforeAll, expect, test } from "vitest";
import { insertAgent } from "../agents/testing/rows.ts";
import { createTestDb } from "../test/helpers.ts";
import { principalSql } from "../test/principals.ts";
import { Neighborhood } from "./neighborhood.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.sql.unsafe(principalSql("u1", "human", "or"));
  await t.sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  const a = (slug: string, reportsTo?: string, archived?: boolean, terminated?: boolean) =>
    insertAgent(t.sql, {
      id: slug,
      slug,
      displayName: slug,
      reportsTo,
      archived,
      terminatedAt: terminated ? new Date() : null,
    });
  await a("ceo");
  await a("ops");
  await a("lead", "ceo");
  await a("dev", "lead");
  await a("pm", "lead");
  await a("old", "lead", true);
  await a("gone", "lead", false, true);
});
afterAll(async () => t.close());

test("manager, peers and reports; archived and terminated excluded; top-level agents are peers", async () => {
  const n = new Neighborhood(t.db);
  const dev = await n.of("dev");
  expect(dev.manager?.slug).toBe("lead");
  expect(dev.peers.map((a) => a.slug)).toEqual(["pm"]);
  expect(dev.reports).toEqual([]);
  const lead = await n.of("lead");
  expect(lead.reports.map((a) => a.slug)).toEqual(["dev", "pm"]);
  const ceo = await n.of("ceo");
  expect(ceo.manager).toBeNull();
  expect(ceo.peers.map((a) => a.slug)).toEqual(["ops"]);
  expect(await n.humans()).toEqual([{ handle: "or", name: "Or" }]);
  expect((await n.all()).map((a) => a.slug)).toEqual(["ceo", "dev", "lead", "ops", "pm"]);
});
