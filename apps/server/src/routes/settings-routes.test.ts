import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FIELD_MSG } from "../field-messages.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestPrincipal } from "../test/principals.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const VALUE = "ghp_ROUTE-SECRET-VALUE";

beforeAll(async () => {
  t = await makeTestApp();
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

test("every route requires a signed-in user (401 before validation)", async () => {
  for (const [method, url] of [
    ["GET", "/api/secrets"],
    ["PUT", "/api/secrets/GH_TOKEN"],
    ["DELETE", "/api/secrets/GH_TOKEN"],
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["PATCH", "/api/projects/app"],
    ["DELETE", "/api/projects/app"],
  ] as const)
    expect((await t.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
});

test("secrets: put, list, delete; the value never comes back", async () => {
  const put = await call("PUT", "/api/secrets/GH_TOKEN", { value: VALUE });
  expect(put.statusCode).toBe(200);
  expect(put.body).not.toContain(VALUE);
  expect(put.json().secret).toMatchObject({ name: "GH_TOKEN", usedBy: [] });
  const list = await call("GET", "/api/secrets");
  expect(list.body).not.toContain(VALUE);
  expect(list.json().secrets.map((s: { name: string }) => s.name)).toEqual(["GH_TOKEN"]);
  expect((await call("DELETE", "/api/secrets/GH_TOKEN")).statusCode).toBe(204);
  expect((await call("DELETE", "/api/secrets/GH_TOKEN")).statusCode).toBe(404);
});

test("secrets: reserved or malformed name and bad value are 400 validation_error", async () => {
  for (const name of [
    "PATH",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "LD_PRELOAD",
    "lower",
  ]) {
    const r = await call("PUT", `/api/secrets/${name}`, { value: "x" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_error");
  }
  const empty = await call("PUT", "/api/secrets/OK_NAME", { value: "" });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error.fields.value).toEqual(expect.any(String));
});

test("projects: create 201, list, patch, conflicts, delete 204 or 409", async () => {
  const dirA = mkdtempSync(path.join(tmpdir(), "of-rp-a-"));
  const dirB = mkdtempSync(path.join(tmpdir(), "of-rp-b-"));
  const created = await call("POST", "/api/projects", { name: "app", hostPath: dirA });
  expect(created.statusCode).toBe(201);
  expect(created.json().project).toMatchObject({ name: "app", grantedTo: [], templates: [] });
  expect((await call("GET", "/api/projects")).json().projects).toHaveLength(1);

  const dup = await call("POST", "/api/projects", { name: "app", hostPath: dirB });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().error.code).toBe("project_exists");
  const missing = await call("POST", "/api/projects", { name: "nope", hostPath: "/x" });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error.fields.hostPath).toBe(FIELD_MSG.noFolder);
  expect(
    (await call("POST", "/api/projects", { name: "Bad Name", hostPath: dirB })).statusCode,
  ).toBe(400);

  const patched = await call("PATCH", "/api/projects/app", { hostPath: dirB });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().project.hostPath).toContain(path.basename(dirB));
  expect((await call("PATCH", "/api/projects/ghost", { hostPath: dirB })).statusCode).toBe(404);

  const agent = await t.seedAgent({ handle: "dev" });
  const [p] = await t.db.select().from(schema.projects).where(eq(schema.projects.name, "app"));
  await t.db
    .insert(schema.agentProjectGrants)
    .values({ agentId: agent.id, projectId: p?.id ?? "" });
  const busy = await call("DELETE", "/api/projects/app");
  expect(busy.statusCode).toBe(409);
  expect(busy.json().error).toMatchObject({
    code: "project_in_use",
    grantedTo: ["dev"],
    archivedGrantedTo: [],
  });
  await t.db.delete(schema.agentProjectGrants);
  expect((await call("DELETE", "/api/projects/app")).statusCode).toBe(204);
});

test("projects: a project granted only to a terminated spawned agent can be removed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "of-rp-t-"));
  expect((await call("POST", "/api/projects", { name: "term", hostPath: dir })).statusCode).toBe(
    201,
  );
  const lead = await t.seedAgent({ handle: "lead-t" });
  await seedTestPrincipal(t.db, "agent", "kid-term-ab12", "kid-term");
  await t.db.insert(schema.agents).values({
    id: "kid-term",
    displayName: "kid",
    template: "t",
    config: lead.config,
    runtime: "local",
    kind: "ephemeral",
    reportsTo: lead.id,
    credentialId: null,
    terminatedAt: new Date(),
  });
  // Termination deletes the grant rows, so a terminated agent holds none.
  expect((await call("DELETE", "/api/projects/term")).statusCode).toBe(204);
});
