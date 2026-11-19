import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";
import { CredentialService } from "./credential-service.ts";
import { CredentialVerifier, type VerifyResult } from "./verify.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let result: VerifyResult = { ok: true };
const seen: string[] = [];
const verifier = {
  verify: async (_k: string, v: string) => {
    seen.push(v);
    return result;
  },
} as unknown as CredentialVerifier;
let svc: CredentialService;
const restarts: string[] = [];

beforeAll(async () => {
  t = await makeTestApp();
  const runtimes = { requestRestart: async (id: string) => void restarts.push(id) };
  svc = new CredentialService({
    db: t.db,
    vault: t.app.vault,
    verifier,
    runtimes: runtimes as never,
  });
});
afterAll(() => t.close());

const TOKEN = "sk-ant-oat01-SECRET-TOKEN-VALUE";

test("create stores a sealed value; list never contains it", async () => {
  result = { ok: true };
  const c = await svc.create({ name: "work", kind: "oauth_token", value: TOKEN });
  expect(c).toMatchObject({ name: "work", kind: "oauth_token", lastError: null, usedBy: [] });
  expect(c.lastVerifiedAt).toEqual(expect.any(String));
  const row = await rowOf("work");
  expect(row.valueEnc.includes(Buffer.from(TOKEN))).toBe(false);
  expect(t.app.vault.open(row.valueEnc, `credentials:${row.id}`)).toBe(TOKEN);
  expect(JSON.stringify(await svc.list())).not.toContain(TOKEN);
  expect(JSON.stringify(c)).not.toContain(TOKEN);
});

test("rejected → 422 credential_rejected and no row; unreachable → credential_unverifiable", async () => {
  result = { ok: false, kind: "rejected", message: "Claude rejected this token." };
  await expect(svc.create({ name: "bad", kind: "oauth_token", value: "x" })).rejects.toMatchObject({
    status: 422,
    code: "credential_rejected",
    message: "Claude rejected this token.",
  });
  result = {
    ok: false,
    kind: "unreachable",
    message: "Couldn't reach Claude to verify. Try again.",
  };
  await expect(svc.create({ name: "bad", kind: "oauth_token", value: "x" })).rejects.toMatchObject({
    status: 422,
    code: "credential_unverifiable",
  });
  expect((await svc.list()).map((c) => c.name)).not.toContain("bad");
  result = { ok: true };
});

test("duplicate name → 409 credential_exists", async () => {
  await expect(svc.create({ name: "work", kind: "oauth_token", value: "y" })).rejects.toMatchObject(
    {
      status: 409,
      code: "credential_exists",
    },
  );
});

async function rowOf(name: string) {
  const [row] = await t.db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.name, name));
  if (!row) throw new Error(`no credential ${name}`);
  return row;
}

async function agentUsing(slug: string, credentialName: string, archived = false) {
  const a = await t.seedAgent({ slug });
  const c = await rowOf(credentialName);
  await t.db
    .update(schema.agents)
    .set({ credentialId: c.id, archivedAt: archived ? new Date() : null })
    .where(eq(schema.agents.id, a.id));
  return a.id;
}

test("replace re-verifies, reseals and restarts each active user (not archived)", async () => {
  const a = await agentUsing("a", "work");
  const b = await agentUsing("b", "work");
  await agentUsing("c", "work", true);
  restarts.length = 0;
  seen.length = 0;
  const r = await svc.replace("work", "new-token-value");
  expect(seen).toEqual(["new-token-value"]);
  expect(r.lastError).toBeNull();
  expect(restarts.sort()).toEqual([a, b].sort());
  const row = await rowOf("work");
  expect(t.app.vault.open(row.valueEnc, `credentials:${row.id}`)).toBe("new-token-value");
});

test("replace with a rejected value keeps the old one and restarts nobody", async () => {
  result = { ok: false, kind: "rejected", message: "Claude rejected this token." };
  restarts.length = 0;
  await expect(svc.replace("work", "nope")).rejects.toMatchObject({ code: "credential_rejected" });
  expect(restarts).toEqual([]);
  const row = await rowOf("work");
  expect(t.app.vault.open(row.valueEnc, `credentials:${row.id}`)).toBe("new-token-value");
  result = { ok: true };
});

test("replace on an unknown credential → 404", async () => {
  await expect(svc.replace("ghost", "v")).rejects.toMatchObject({
    status: 404,
    code: "credential_not_found",
  });
});

test("reverify records lastVerifiedAt on success and lastError on failure; always returns the summary", async () => {
  result = { ok: false, kind: "rejected", message: "Claude rejected this token." };
  seen.length = 0;
  const bad = await svc.reverify("work");
  expect(seen).toEqual(["new-token-value"]);
  expect(bad.lastError).toBe("Claude rejected this token.");
  result = { ok: true };
  const good = await svc.reverify("work");
  expect(good.lastError).toBeNull();
  expect(good.lastVerifiedAt).toEqual(expect.any(String));
  expect((await svc.list()).find((c) => c.name === "work")).toMatchObject({ lastError: null });
});

test("remove while used → 409 with usedBy, archivedUsedBy and both sentences", async () => {
  await expect(svc.remove("work")).rejects.toMatchObject({
    status: 409,
    code: "credential_in_use",
    message:
      "Used by @a and @b. Change their credential first. Archived agents @c still reference it. Edit them first.",
    extra: { usedBy: ["a", "b"], archivedUsedBy: ["c"] },
  });
});

test("remove: only-active and only-archived wording", async () => {
  result = { ok: true };
  await svc.create({ name: "solo", kind: "api_key", value: "k" });
  await agentUsing("d", "solo");
  await expect(svc.remove("solo")).rejects.toMatchObject({
    message: "Used by @d. Change their credential first.",
    extra: { usedBy: ["d"], archivedUsedBy: [] },
  });
  await svc.create({ name: "old", kind: "api_key", value: "k" });
  await agentUsing("e", "old", true);
  await expect(svc.remove("old")).rejects.toMatchObject({
    message: "Archived agents @e still reference it. Edit them first.",
  });
});

test("remove when unused succeeds", async () => {
  await svc.create({ name: "spare", kind: "api_key", value: "k" });
  await svc.remove("spare");
  expect((await svc.list()).map((c) => c.name)).not.toContain("spare");
  await expect(svc.remove("spare")).rejects.toMatchObject({ status: 404 });
});

test("a failing verification run never logs or returns the value or raw output", async () => {
  const leak = `fatal: https://user:pw@example.com/x ${TOKEN}`;
  const driver = new FakeDriver();
  const real = new CredentialVerifier({ driver, claudeBin: "/x", timeoutMs: 2000 });
  const logged: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      logged.push(String(c));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      logged.push(String(c));
      return true;
    }),
    vi.spyOn(console, "log").mockImplementation((...a) => void logged.push(a.join(" "))),
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" "))),
  ];
  try {
    const p = real.verify("oauth_token", TOKEN);
    await vi.waitFor(() => expect(driver.starts.length).toBe(1));
    driver.last.emit(
      ev.session(),
      { type: "error", source: "api", message: leak, detail: leak },
      ev.end({ isError: true }),
    );
    const out = await p;
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain("user:pw@");
  } finally {
    for (const s of spies) s.mockRestore();
  }
  expect(logged.join("\n")).not.toContain(TOKEN);
  expect(logged.join("\n")).not.toContain("user:pw@");
});
