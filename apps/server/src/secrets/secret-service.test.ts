import { randomUUID } from "node:crypto";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal } from "../test/principals.ts";
import { SecretService } from "./secret-service.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let svc: SecretService;
const restarts: string[] = [];
const VALUE = "ghp_SUPER-SECRET-VALUE-123";

beforeAll(async () => {
  t = await makeTestApp();
  const runtimes = { requestRestart: async (id: string) => void restarts.push(id) };
  svc = new SecretService({ db: t.db, vault: t.app.vault, runtimes: runtimes as never });
});
afterAll(() => t.close());

async function rowOf(name: string) {
  const [row] = await t.db.select().from(schema.secrets).where(eq(schema.secrets.name, name));
  if (!row) throw new Error(`no secret ${name}`);
  return row;
}

test("put creates, then updates in place (same id, new updatedAt); bytes never hold the value", async () => {
  const first = await svc.put("GH_TOKEN", VALUE);
  expect(first).toMatchObject({ name: "GH_TOKEN", usedBy: [] });
  const r1 = await rowOf("GH_TOKEN");
  expect(r1.valueEnc.includes(Buffer.from(VALUE))).toBe(false);
  expect(t.app.vault.open(r1.valueEnc, `secrets:${r1.id}`)).toBe(VALUE);
  await new Promise((r) => setTimeout(r, 15));
  const second = await svc.put("GH_TOKEN", "new-value-456");
  const r2 = await rowOf("GH_TOKEN");
  expect(r2.id).toBe(r1.id);
  expect(t.app.vault.open(r2.valueEnc, `secrets:${r2.id}`)).toBe("new-value-456");
  expect(second.updatedAt).not.toBe(first.updatedAt);
  expect(JSON.stringify([first, second, await svc.list()])).not.toContain(VALUE);
  expect(JSON.stringify(await svc.list())).not.toContain("new-value-456");
});

test("usedBy comes from non-archived agents' overlays; put and remove restart exactly those", async () => {
  const a = await t.seedAgent({ slug: "alpha", config: { template: { secrets: ["GH_TOKEN"] } } });
  const b = await t.seedAgent({
    slug: "beta",
    config: { template: { secrets: ["GH_TOKEN", "OTHER"] } },
  });
  const old = await t.seedAgent({ slug: "old", config: { template: { secrets: ["GH_TOKEN"] } } });
  await t.seedAgent({ slug: "none", config: { template: { secrets: ["OTHER"] } } });
  await t.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.id, old.id));
  expect((await svc.list()).find((s) => s.name === "GH_TOKEN")?.usedBy).toEqual(["alpha", "beta"]);

  restarts.length = 0;
  const put = await svc.put("GH_TOKEN", "v3");
  expect(put.usedBy).toEqual(["alpha", "beta"]);
  expect(restarts.sort()).toEqual([a.id, b.id].sort());

  restarts.length = 0;
  await svc.remove("GH_TOKEN");
  expect(restarts.sort()).toEqual([a.id, b.id].sort());
  expect((await svc.list()).map((s) => s.name)).not.toContain("GH_TOKEN");
});

test("remove of a missing secret is a 404", async () => {
  await expect(svc.remove("NOPE")).rejects.toMatchObject({
    status: 404,
    code: "secret_not_found",
    message: "No secret named NOPE.",
  });
});

test("one failed restart does not abort the others or the write, and is logged by slug only", async () => {
  const a = await t.seedAgent({ slug: "sec-fail-a", config: { template: { secrets: ["FAILS"] } } });
  const b = await t.seedAgent({ slug: "sec-fail-b", config: { template: { secrets: ["FAILS"] } } });
  const seen: string[] = [];
  const warns: { obj: object; msg: string }[] = [];
  const failing = new SecretService({
    db: t.db,
    vault: t.app.vault,
    log: { warn: (obj, msg) => void warns.push({ obj, msg }) },
    runtimes: {
      requestRestart: async (id: string) => {
        seen.push(id);
        if (id === a.id) throw new Error("boom");
      },
    } as never,
  });
  const out = await failing.put("FAILS", VALUE);
  expect(out.name).toBe("FAILS");
  expect(seen.sort()).toEqual([a.id, b.id].sort());
  const row = await rowOf("FAILS");
  expect(t.app.vault.open(row.valueEnc, `secrets:${row.id}`)).toBe(VALUE);
  expect(warns).toHaveLength(1);
  expect(warns[0]?.obj).toEqual({ slug: "sec-fail-a" });
  expect(JSON.stringify(warns)).not.toContain("boom");
  await failing.remove("FAILS");
});

test("I2 §6.7: a secret only the template lists: its live agents and their live children; rotate and delete restart them", async () => {
  await t.db.insert(schema.templates).values({
    name: "gh-tpl",
    path: "/tpl/gh-tpl",
    contentHash: "h",
    scannedAt: new Date(),
    valid: true,
    lastValid: {
      template: { name: "gh-tpl", display_name: "GH", secrets: ["TPL_ONLY"] },
      settings: {},
      mcp: { mcpServers: {} },
    },
  });
  const lead = await t.seedAgent({ slug: "tpl-lead" });
  const archived = await t.seedAgent({ slug: "tpl-archived" });
  // Same secret name nowhere in its template or overlay: not a user.
  await t.seedAgent({ slug: "tpl-other" });
  for (const a of [lead, archived])
    await t.db.update(schema.agents).set({ template: "gh-tpl" }).where(eq(schema.agents.id, a.id));
  await t.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.id, archived.id));
  // A live child (its own template doesn't list the secret: it inherits its spawner's) and a terminated one.
  const kid = randomUUID();
  const gone = randomUUID();
  for (const [id, slug, terminated] of [
    [kid, "tpl-kid", false],
    [gone, "tpl-gone", true],
  ] as const) {
    await seedTestPrincipal(t.db, "agent", slug, id);
    await t.db.insert(schema.agents).values({
      id,
      slug,
      displayName: slug,
      template: "test",
      runtime: "local",
      kind: "ephemeral",
      reportsTo: lead.id,
      credentialId: lead.credentialId,
      ...(terminated ? { terminatedAt: new Date(), terminatedBy: "@or" } : {}),
    });
  }
  restarts.length = 0;
  const put = await svc.put("TPL_ONLY", VALUE);
  expect(put.usedBy).toEqual(["tpl-kid", "tpl-lead"]);
  expect(restarts.sort()).toEqual([kid, lead.id].sort());
  expect((await svc.list()).find((s) => s.name === "TPL_ONLY")?.usedBy).toEqual([
    "tpl-kid",
    "tpl-lead",
  ]);
  restarts.length = 0;
  await svc.remove("TPL_ONLY");
  expect(restarts.sort()).toEqual([kid, lead.id].sort());
});
