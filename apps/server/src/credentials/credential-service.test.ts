import { schema } from "@open-factory/db";
import type { ServerMessage } from "@open-factory/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal } from "../test/principals.ts";
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
const failRestart = new Set<string>();
const warns: { obj: object; msg: string }[] = [];
const published: ServerMessage[] = [];

beforeAll(async () => {
  t = await makeTestApp();
  const runtimes = {
    requestRestart: async (id: string) => {
      if (failRestart.has(id)) throw new Error("boom");
      restarts.push(id);
    },
  };
  svc = new CredentialService({
    db: t.db,
    vault: t.app.vault,
    verifier,
    runtimes: runtimes as never,
    bus: { publishAll: (m) => void published.push(m) },
    now: () => new Date(),
    log: { warn: (obj, msg) => void warns.push({ obj, msg }) },
  });
});
afterAll(() => t.close());

const TOKEN = "sk-ant-oat01-SECRET-TOKEN-VALUE";

test("create stores a sealed value; list never contains it", async () => {
  result = { ok: true };
  const c = await svc.create({ name: "work", kind: "oauth_token", value: TOKEN, expiresAt: null });
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
  await expect(
    svc.create({ name: "bad", kind: "oauth_token", value: "x", expiresAt: null }),
  ).rejects.toMatchObject({
    status: 422,
    code: "credential_rejected",
    message: "Claude rejected this token.",
  });
  result = {
    ok: false,
    kind: "unreachable",
    message: FIELD_MSG.claudeUnreachable,
  };
  await expect(
    svc.create({ name: "bad", kind: "oauth_token", value: "x", expiresAt: null }),
  ).rejects.toMatchObject({
    status: 422,
    code: "credential_unverifiable",
  });
  expect((await svc.list()).map((c) => c.name)).not.toContain("bad");
  result = { ok: true };
});

test("duplicate name → 409 credential_exists before any paid verification turn", async () => {
  seen.length = 0;
  await expect(
    svc.create({ name: "work", kind: "oauth_token", value: "y", expiresAt: null }),
  ).rejects.toMatchObject({
    status: 409,
    code: "credential_exists",
  });
  expect(seen).toEqual([]);
});

async function rowOf(name: string) {
  const [row] = await t.db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.name, name));
  if (!row) throw new Error(`no credential ${name}`);
  return row;
}

async function agentUsing(handle: string, credentialName: string, archived = false) {
  const a = await t.seedAgent({ handle });
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
    message: "No credential named ghost.",
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

test("replace: one rejected restart doesn't abort the others and is logged by handle only", async () => {
  const a = await agentUsing("fa", "work");
  const b = await agentUsing("fb", "work");
  failRestart.add(a);
  restarts.length = 0;
  warns.length = 0;
  try {
    const r = await svc.replace("work", "newer-token-value");
    expect(r.lastError).toBeNull();
  } finally {
    failRestart.clear();
  }
  expect(restarts).toContain(b);
  expect(restarts).not.toContain(a);
  expect(warns).toHaveLength(1);
  expect(warns[0]?.obj).toEqual({ handle: "fa" });
  expect(JSON.stringify(warns)).not.toContain("boom");
  await t.db.delete(schema.agents).where(inArray(schema.agents.id, [a, b]));
});

test("reverify of an undecryptable value → readable 409, not a 500", async () => {
  result = { ok: true };
  await svc.create({ name: "broken", kind: "api_key", value: "k", expiresAt: null });
  await t.db
    .update(schema.credentials)
    .set({ valueEnc: Buffer.alloc(40, 1) })
    .where(eq(schema.credentials.name, "broken"));
  seen.length = 0;
  await expect(svc.reverify("broken")).rejects.toMatchObject({
    status: 409,
    code: "credential_undecryptable",
    message: "Can't decrypt credential broken. Was FACTORY_SECRET_KEY changed?",
  });
  expect(seen).toEqual([]);
});

test("remove while used → 409 with usedBy, archivedUsedBy and both sentences", async () => {
  await expect(svc.remove("work")).rejects.toMatchObject({
    status: 409,
    code: "credential_in_use",
    message:
      "Used by @a, @b. Change their credential first. Archived agents @c still reference it. Edit them first.",
    extra: { usedBy: ["a", "b"], archivedUsedBy: ["c"] },
  });
});

test("remove: only-active and only-archived wording", async () => {
  result = { ok: true };
  await svc.create({ name: "solo", kind: "api_key", value: "k", expiresAt: null });
  await agentUsing("d", "solo");
  await expect(svc.remove("solo")).rejects.toMatchObject({
    message: "Used by @d. Change their credential first.",
    extra: { usedBy: ["d"], archivedUsedBy: [] },
  });
  await svc.create({ name: "old", kind: "api_key", value: "k", expiresAt: null });
  await agentUsing("e", "old", true);
  await expect(svc.remove("old")).rejects.toMatchObject({
    message: "Archived agents @e still reference it. Edit them first.",
  });
});

async function spawnedUsing(
  handle: string,
  spawnerId: string,
  credentialName: string,
  terminated = false,
) {
  const c = await rowOf(credentialName);
  const id = `${handle}-id`;
  await seedTestPrincipal(t.db, "agent", handle, id);
  await t.db.insert(schema.agents).values({
    id,
    displayName: handle,
    template: "t",
    config: {} as never,
    runtime: "local",
    kind: "ephemeral",
    reportsTo: spawnerId,
    credentialId: c.id,
    terminatedAt: terminated ? new Date() : null,
  });
  return id;
}

test("#30: a credential used only by a terminated agent deletes and nulls its reference", async () => {
  result = { ok: true };
  await svc.create({ name: "gone", kind: "api_key", value: "k", expiresAt: null });
  const lead = await agentUsing("lead1", "gone");
  // The spawner moves off; only the terminated kid still references it.
  await svc.create({ name: "elsewhere", kind: "api_key", value: "k", expiresAt: null });
  await t.db
    .update(schema.agents)
    .set({ credentialId: (await rowOf("elsewhere")).id })
    .where(eq(schema.agents.id, lead));
  const kid = await spawnedUsing("kid-t1", lead, "gone", true);
  await svc.remove("gone");
  const [row] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, kid));
  expect(row?.credentialId).toBeNull();
});

test("#30: a live spawned user is named as its spawner, once", async () => {
  result = { ok: true };
  await svc.create({ name: "lent", kind: "api_key", value: "k", expiresAt: null });
  const lead = await agentUsing("lead", "lent");
  await spawnedUsing("kid-a", lead, "lent");
  await spawnedUsing("kid-b", lead, "lent");
  await spawnedUsing("kid-dead", lead, "lent", true);
  await expect(svc.remove("lent")).rejects.toMatchObject({
    status: 409,
    code: "credential_in_use",
    message: "Used by @lead. Change their credential first.",
    extra: { usedBy: ["lead"], archivedUsedBy: [] },
  });
});

test("#30: a live user inserted between the check and the delete is a 409 (the 23514 path)", async () => {
  result = { ok: true };
  await svc.create({ name: "race30", kind: "api_key", value: "k", expiresAt: null });
  await agentUsing("racer30", "race30");
  const spy = vi
    .spyOn(svc as unknown as { users: (id: string) => Promise<unknown> }, "users")
    .mockResolvedValueOnce({ active: [], archived: [] });
  try {
    await expect(svc.remove("race30")).rejects.toMatchObject({
      status: 409,
      code: "credential_in_use",
      message: "Used by @racer30. Change their credential first.",
      extra: { usedBy: ["racer30"], archivedUsedBy: [] },
    });
  } finally {
    spy.mockRestore();
  }
  expect((await svc.list()).map((c) => c.name)).toContain("race30");
});

test("remove when unused succeeds", async () => {
  await svc.create({ name: "spare", kind: "api_key", value: "k", expiresAt: null });
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

test("create stores expiresAt; paste passes null", async () => {
  result = { ok: true };
  const c = await svc.create({
    name: "w-exp",
    kind: "oauth_token",
    value: "sk-ant-oat01-SYNTHETICxxxxxxxxxxxxxxxx",
    expiresAt: new Date("2027-11-12T00:00:00Z"),
  });
  expect(c.expiresAt).toBe("2027-11-12T00:00:00.000Z");
  expect(c.rejected).toBe(false);
  const pasted = await svc.create({
    name: "w-paste",
    kind: "oauth_token",
    value: "p",
    expiresAt: null,
  });
  expect(pasted.expiresAt).toBeNull();
});

test("insertVerified never calls the verifier, seals the value and rejects a duplicate name", async () => {
  const before = seen.length;
  const summary = await svc.insertVerified({
    name: "w-iv",
    kind: "oauth_token",
    value: "v",
    expiresAt: null,
  });
  expect(seen.length).toBe(before);
  const row = await rowOf("w-iv");
  expect(t.app.vault.open(row.valueEnc, `credentials:${row.id}`)).toBe("v");
  expect(JSON.stringify(summary)).not.toContain('"v"');
  await expect(
    svc.insertVerified({ name: "w-iv", kind: "oauth_token", value: "v2", expiresAt: null }),
  ).rejects.toMatchObject({ status: 409, code: "credential_exists" });
  expect(seen.length).toBe(before);
});

test("replaceVerified keeps the id, sets expiry, clears notified/rejected and publishes inbox_changed", async () => {
  result = { ok: true };
  const c = await svc.create({ name: "w-rv", kind: "oauth_token", value: "a", expiresAt: null });
  const row = await rowOf("w-rv");
  await t.db
    .update(schema.credentials)
    .set({ expiryNotifiedAt: new Date(), rejectedAt: new Date() })
    .where(eq(schema.credentials.id, row.id));
  published.length = 0;
  const r = await svc.replaceVerified(row.id, "b", { expiresAt: new Date("2028-01-01T00:00:00Z") });
  expect(r.name).toBe(c.name);
  expect(r.expiresAt).toBe("2028-01-01T00:00:00.000Z");
  const after = await rowOf("w-rv");
  expect(after.id).toBe(row.id);
  expect(after.expiryNotifiedAt).toBeNull();
  expect(after.rejectedAt).toBeNull();
  expect(published).toContainEqual({ type: "inbox_changed" });
});

test("replaceVerified publishes nothing when no expiry notice was sent", async () => {
  const row = await rowOf("w-rv");
  published.length = 0;
  await svc.replaceVerified(row.id, "c", { expiresAt: null });
  expect(published).toEqual([]);
});

test("replaceVerified on a deleted id is 404", async () => {
  await expect(svc.replaceVerified("missing", "b", { expiresAt: null })).rejects.toMatchObject({
    code: "credential_not_found",
  });
});

test("byName and nameTaken", async () => {
  expect(await svc.nameTaken("w-rv")).toBe(true);
  expect(await svc.nameTaken("nope-xyz")).toBe(false);
  expect(await svc.byName("w-rv")).toMatchObject({ name: "w-rv", kind: "oauth_token" });
  expect(await svc.byName("nope-xyz")).toBeUndefined();
});

test("reverify sets rejected_at on rejected, clears on ok, leaves it on unreachable", async () => {
  result = { ok: true };
  await svc.create({ name: "w-rj", kind: "oauth_token", value: "a", expiresAt: null });
  result = { ok: false, kind: "rejected", message: "Claude rejected this token." };
  const bad = await svc.reverify("w-rj");
  expect(bad.rejected).toBe(true);
  const rejectedAt = (await rowOf("w-rj")).rejectedAt;
  expect(rejectedAt).not.toBeNull();
  result = { ok: false, kind: "unreachable", message: FIELD_MSG.claudeUnreachable };
  const unreachable = await svc.reverify("w-rj");
  expect(unreachable.lastError).toBe(FIELD_MSG.claudeUnreachable);
  expect((await rowOf("w-rj")).rejectedAt).toEqual(rejectedAt);
  result = { ok: true };
  const good = await svc.reverify("w-rj");
  expect(good.rejected).toBe(false);
  expect((await rowOf("w-rj")).rejectedAt).toBeNull();
});
