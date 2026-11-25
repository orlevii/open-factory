import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claimTestHandle } from "../test/handles.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
beforeEach(async () => {
  h = await makeTestApp();
  cookie = (await signUp(h.app, { handle: "or" })).cookie;
});
afterEach(() => h.close());

const getSetup = (headers: Record<string, string> = { cookie }) =>
  h.app.inject({ method: "GET", url: "/api/setup", headers });

test("GET /api/setup: an empty factory has no credential, template or agent yet", async () => {
  const r = await getSetup();
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ hasCredential: false, hasTemplate: false, hasAgent: false });
});

test("GET /api/setup: a saved credential shows as hasCredential", async () => {
  await h.db.insert(schema.credentials).values({
    id: "cred-1",
    name: "claude",
    kind: "oauth_token",
    valueEnc: Buffer.from("sealed"),
  });
  const r = await getSetup();
  expect(r.json()).toEqual({ hasCredential: true, hasTemplate: false, hasAgent: false });
});

test("GET /api/setup: a template with issues still counts as hasTemplate", async () => {
  await h.db.insert(schema.templates).values({
    name: "broken",
    path: "/tmp/broken",
    contentHash: "hash",
    issues: [{ severity: "error", file: "template.yaml", message: "bad yaml" }],
    valid: false,
    scannedAt: new Date(),
  });
  const r = await getSetup();
  expect(r.json()).toEqual({ hasCredential: false, hasTemplate: true, hasAgent: false });
});

test("GET /api/setup: an archived agent still counts as hasAgent", async () => {
  await h.seedAgent({ slug: "ada" });
  await h.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.slug, "ada"));
  const r = await getSetup();
  expect(r.json()).toEqual({ hasCredential: true, hasTemplate: false, hasAgent: true });
});

test("GET /api/setup: a terminated ephemeral agent alone still counts as hasAgent", async () => {
  const boss = await h.seedAgent({ slug: "boss" });
  await claimTestHandle(h.db, "eph", "agent");
  await h.db.insert(schema.agents).values({
    id: "eph-1",
    slug: "eph",
    displayName: "Ephemeral",
    template: "test",
    runtime: "local",
    kind: "ephemeral",
    reportsTo: boss.id,
    terminatedAt: new Date(),
    terminatedBy: "@or",
  });
  const r = await getSetup();
  expect(r.json()).toEqual({ hasCredential: true, hasTemplate: false, hasAgent: true });
});

test("GET /api/setup without a human session is refused with 401", async () => {
  const r = await getSetup({});
  expect(r.statusCode).toBe(401);
});
