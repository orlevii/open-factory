import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { type Actor, LOCAL_RUNTIME_REFUSAL } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { makeTestApp } from "../test/helpers.ts";
import { seedTestUser } from "../test/principals.ts";
import type { ConfigService } from "./config-service.ts";
import { OrgRefusedError } from "./errors.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cfg: ConfigService;
let home: string;
const human: Actor = { kind: "human", handle: "or" };
let hr: Actor;

function writeTemplate(name: string, runtime: "docker" | "local") {
  const d = path.join(home, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    `name: ${name}\ndisplay_name: ${name}\nruntime: ${runtime}\n`,
  );
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
  writeFileSync(path.join(d, "settings.json"), JSON.stringify({}));
}
const body = (slug: string, template = "dev") => ({
  template,
  slug,
  displayName: slug,
  description: "",
  reportsTo: "or",
  credential: "work",
});
const rowOf = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r;
};
const versionOf = async (slug: string) => (await cfg.getConfig(slug)).version;
const events = (agentId: string) =>
  t.sql<{ payload: { by: string; changes: string[] } }[]>`
    select payload from session_events where agent_id = ${agentId} and type = 'config_changed'`;

beforeAll(async () => {
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: createFakeClaude({ scenario: "reply" }).bin },
  });
  await seedTestUser(t.db, "or");
  home = t.factoryHome;
  cfg = t.app.configs;
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal("tok", `credentials:${credId}`),
  });
  writeTemplate("dev", "docker");
  writeTemplate("localtpl", "local");
  const svc = t.app.agents;
  await svc.create(body("hr-bot"), human);
  await svc.create(body("dev"), human);
  await svc.create(body("loc", "localtpl"), human);
  const hrRow = await rowOf("hr-bot");
  hr = { kind: "agent", id: hrRow.id, slug: "hr-bot" };
});
afterAll(() => t.close());

/** The ApiError a call rejects with. */
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error("expected an ApiError");
  return err;
};

test("a stale baseVersion is refused to an agent as an org refusal and to a human as 409 config_changed", async () => {
  await expect(cfg.saveOverlay("dev", {}, "stale", hr)).rejects.toThrow(
    new OrgRefusedError("@dev's configuration changed since you read it; call get_agent again."),
  );
  const err = await refusal(cfg.saveOverlay("dev", {}, "stale", human));
  expect(err).toMatchObject({
    status: 409,
    code: "config_changed",
    message: "Changed since you opened it.",
  });
});

test("an agent can't remove an overlay deny rule, and nothing is written", async () => {
  const stored = { settings: { permissions: { deny: ["Bash(rm:*)"] } } };
  await t.db.update(schema.agents).set({ config: stored }).where(eq(schema.agents.slug, "dev"));
  const version = await versionOf("dev");
  const err = await refusal(cfg.saveOverlay("dev", {}, version, hr));
  expect(err).toMatchObject({ status: 400, code: "invalid_config" });
  expect(JSON.stringify(err.extra)).toContain("Deny rules can only be removed by a human.");
  expect((await rowOf("dev")).config).toEqual(stored);
  await t.db.update(schema.agents).set({ config: {} }).where(eq(schema.agents.slug, "dev"));
});

test("a spawned target is refused: Spawned agents can't be edited", async () => {
  await t.db
    .update(schema.agents)
    .set({
      kind: "ephemeral",
      reportsTo: (await rowOf("dev")).id,
    })
    .where(eq(schema.agents.slug, "loc"));
  try {
    await expect(cfg.saveOverlay("loc", {}, "x", human)).rejects.toMatchObject({
      status: 409,
      code: "ephemeral_agent",
      message: "Spawned agents can't be edited; terminate it instead.",
    });
  } finally {
    await t.db
      .update(schema.agents)
      .set({ kind: "persistent", reportsTo: "u-or" })
      .where(eq(schema.agents.slug, "loc"));
  }
});

test("an agent can't save the overlay of a local agent; a human can", async () => {
  await expect(cfg.saveOverlay("loc", {}, await versionOf("loc"), hr)).rejects.toThrow(
    new OrgRefusedError(LOCAL_RUNTIME_REFUSAL),
  );
  await expect(cfg.saveOverlay("loc", {}, await versionOf("loc"), human)).resolves.toMatchObject({
    checked: "full",
  });
});

test("an agent can't give an overlay a can_spawn that names a local template", async () => {
  const overlay = { template: { can_spawn: ["localtpl"] } };
  await expect(cfg.saveOverlay("dev", overlay, await versionOf("dev"), hr)).rejects.toThrow(
    new OrgRefusedError(LOCAL_RUNTIME_REFUSAL),
  );
});

test("a valid agent save writes the overlay and a config_changed event by the agent", async () => {
  const overlay = { template: { model: "opus" } };
  const out = await cfg.saveOverlay("dev", overlay, await versionOf("dev"), hr);
  expect(out).toMatchObject({ overlay, checked: "full" });
  const dev = await rowOf("dev");
  expect(dev.config).toEqual(overlay);
  await vi.waitFor(async () =>
    expect((await events(dev.id)).map((e) => e.payload.by)).toContain("@hr-bot"),
  );
});

test("a human save attributes the event to the human", async () => {
  const dev = await rowOf("dev");
  await cfg.saveOverlay("dev", {}, await versionOf("dev"), human);
  await vi.waitFor(async () =>
    expect((await events(dev.id)).map((e) => e.payload.by)).toContain("@or"),
  );
});

test("a save whose version went stale under the lock is refused and writes nothing", async () => {
  const plan = await cfg.planOverlay(
    "dev",
    { template: { model: "sonnet" } },
    await versionOf("dev"),
    human,
  );
  await t.db
    .update(schema.agents)
    .set({ config: { template: { model: "haiku" } } })
    .where(eq(schema.agents.slug, "dev"));
  await expect(
    t.db.transaction(async (tx) => plan.write(tx, await rowOf("dev"))),
  ).rejects.toMatchObject({ status: 409, code: "config_changed" });
  expect((await rowOf("dev")).config).toEqual({ template: { model: "haiku" } });
});

test("with an invalid template the agent policy still applies to an overlay; a human only gets the schema check", async () => {
  const tdir = path.join(home, "templates", "dev");
  const good = readFileSync(path.join(tdir, "template.yaml"), "utf8");
  const stored = { settings: { permissions: { deny: ["Bash(rm:*)"] } } };
  await t.db.update(schema.agents).set({ config: stored }).where(eq(schema.agents.slug, "dev"));
  writeFileSync(path.join(tdir, "template.yaml"), "name: [unclosed\n");
  try {
    const version = await versionOf("dev");
    const removed = await refusal(cfg.saveOverlay("dev", {}, version, hr));
    expect(removed).toMatchObject({ status: 400, code: "invalid_config" });
    expect(JSON.stringify(removed.extra)).toContain("Deny rules can only be removed by a human.");
    expect((await rowOf("dev")).config).toEqual(stored);

    const env = { ...stored, settings: { ...stored.settings, env: { HTTPS_PROXY: "http://x" } } };
    const proxied = await refusal(cfg.saveOverlay("dev", env, version, hr));
    expect(proxied).toMatchObject({ status: 400, code: "invalid_config" });
    expect(JSON.stringify(proxied.extra)).toContain("HTTPS_PROXY");
    expect((await rowOf("dev")).config).toEqual(stored);

    await cfg.saveOverlay("dev", {}, version, human);
    expect((await rowOf("dev")).config).toEqual({});
  } finally {
    writeFileSync(path.join(tdir, "template.yaml"), good);
    await t.db.update(schema.agents).set({ config: {} }).where(eq(schema.agents.slug, "dev"));
  }
});

test("an agent's save that goes stale between planning and the row lock is an org refusal", async () => {
  const plan = await cfg.planOverlay("dev", {}, await versionOf("dev"), hr);
  await t.db
    .update(schema.agents)
    .set({ config: { template: { can_spawn: ["x"] } } })
    .where(eq(schema.agents.slug, "dev"));
  try {
    await expect(
      t.db.transaction(async (tx) => plan.write(tx, await rowOf("dev"))),
    ).rejects.toBeInstanceOf(OrgRefusedError);
  } finally {
    await t.db.update(schema.agents).set({ config: {} }).where(eq(schema.agents.slug, "dev"));
  }
});
