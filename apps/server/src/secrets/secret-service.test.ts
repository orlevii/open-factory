import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
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

test("usedBy comes from non-archived agent snapshots; put and remove restart exactly those", async () => {
  const a = await t.seedAgent({ slug: "alpha", config: { secrets: ["GH_TOKEN"] } });
  const b = await t.seedAgent({ slug: "beta", config: { secrets: ["GH_TOKEN", "OTHER"] } });
  const old = await t.seedAgent({ slug: "old", config: { secrets: ["GH_TOKEN"] } });
  await t.seedAgent({ slug: "none", config: { secrets: ["OTHER"] } });
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

test("one failed restart does not abort the others or the write", async () => {
  const a = await t.seedAgent({ slug: "sec-fail-a", config: { secrets: ["FAILS"] } });
  const b = await t.seedAgent({ slug: "sec-fail-b", config: { secrets: ["FAILS"] } });
  const seen: string[] = [];
  const failing = new SecretService({
    db: t.db,
    vault: t.app.vault,
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
  await failing.remove("FAILS");
});
