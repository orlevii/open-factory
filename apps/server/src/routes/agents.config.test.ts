import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import { overlayVersion } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, TEST_TEMPLATE_YAML } from "../test/helpers.ts";

/** I2 §12.1: `GET` and `PUT /api/agents/:slug/config`. Needs Postgres, so it runs in CI. */

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seedAgent();
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const get = (slug = "dev") => call("GET", `/api/agents/${slug}/config`);
const put = (overlay: unknown, baseVersion: string, slug = "dev") =>
  call("PUT", `/api/agents/${slug}/config`, { overlay, baseVersion } as Record<string, unknown>);
const templateYaml = () => path.join(t.factoryHome, "templates", "test", "template.yaml");

const SECRET = "sk-ant-SECRET0123456789";
const reset = async (slug = "dev") => {
  await t.db.update(schema.agents).set({ config: {} }).where(eq(schema.agents.slug, slug));
};

describe("GET", () => {
  test("an empty overlay: its version, the template's doc, and the merged doc equal to it", async () => {
    await reset();
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      overlay: {},
      version: overlayVersion({}),
      template: { name: "test", valid: true, doc: expect.any(Object) },
      issues: [],
    });
    expect(Object.keys(body.template.doc.template).length).toBeGreaterThan(0);
    expect(body.merged).toEqual(body.template.doc);
  });

  test("local_skill_names never leaves the server", async () => {
    const skillsDir = path.join(t.factoryHome, "templates", "test", "skills");
    const tplSkills = path.join(skillsDir, "release");
    mkdirSync(tplSkills, { recursive: true });
    writeFileSync(path.join(tplSkills, "SKILL.md"), "---\nname: release\n---\n");
    try {
      // Positive control: the server's own doc does carry the derived key, so its absence below means it was stripped.
      const internal = await t.app.templates.loadValid("test");
      expect(internal.doc.template.local_skill_names).toEqual(["release"]);
      const r = await get();
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(r.json())).not.toContain("local_skill_names");
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  test("an unknown agent is 404", async () => {
    expect((await get("nope")).statusCode).toBe(404);
  });
});

describe("PUT", () => {
  test("saves, returns the GET shape with changes, and the next GET shows it", async () => {
    await reset();
    const base = (await get()).json().version;
    const overlay = { template: { model: "opus", skills: [] } };
    const r = await put(overlay, base);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      overlay,
      version: overlayVersion(overlay),
      checked: "full",
      changes: ["model: default → opus"],
      // Nothing runs: no restart check was scheduled.
      restartChecked: false,
    });
    expect(body.merged.template.model).toBe("opus");
    expect((await get()).json().version).toBe(body.version);
    const events = (await call("GET", "/api/agents/dev/events")).json().events;
    expect(events.map((e: { event: { type: string } }) => e.event.type)).toContain(
      "config_changed",
    );
  });

  test("a running agent: a restart check is scheduled, and the answer doesn't wait for it", async () => {
    await reset();
    await call("POST", "/api/messages", { to: ["dev"], body: "hi", urgent: false });
    driver.last.emit(ev.session(), ev.turn(), ev.text("ok"), ev.usage(), ev.end());
    const rt = await t.app.runtimes.bySlug("dev");
    await rt?.settled();
    const base = (await get()).json().version;
    const r = await put({ template: { effort: "high" } }, base);
    expect(r.statusCode).toBe(200);
    // A check was scheduled for the running process; the answer is not "restarting".
    expect(r.json()).toMatchObject({ checked: "full", restartChecked: true });
    expect(r.json()).not.toHaveProperty("restart");
  });

  test("a stale version is 409 config_changed and writes nothing", async () => {
    await reset();
    const stale = (await get()).json().version;
    expect((await put({ template: { model: "opus" } }, stale)).statusCode).toBe(200);
    const r = await put({ template: { model: "haiku" } }, stale);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "config_changed" });
    expect((await get()).json().overlay).toEqual({ template: { model: "opus" } });
  });

  test("two saves from the same version: one wins, one is 409", async () => {
    await reset();
    const base = (await get()).json().version;
    const [a, b] = await Promise.all([
      put({ template: { model: "opus" } }, base),
      put({ template: { model: "haiku" } }, base),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? a : b;
    expect((await get()).json().overlay).toEqual(winner.json().overlay);
  });

  test("an invalid overlay is 400 with paths and constant messages; nothing is written", async () => {
    await reset();
    const base = (await get()).json().version;
    const r = await put(
      {
        template: { secrets: [SECRET], model: `${SECRET}!` },
        settings: { env: { [SECRET]: SECRET, ANTHROPIC_API_KEY: SECRET } },
        mcp: { mcpServers: { factory: { command: SECRET, args: [SECRET], url: SECRET } } },
        [SECRET]: 1,
      },
      base,
    );
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_config");
    expect(r.json().error.issues.length).toBeGreaterThan(0);
    expect(r.body).not.toContain(SECRET);
    expect((await get()).json().overlay).toEqual({});
  });

  test("an effective error is 400 with its path and no value", async () => {
    await reset();
    const base = (await get()).json().version;
    // A missing host skill is an error of the merged doc (an undefined secret is only a warning, spec §6.3).
    const r = await put({ template: { skills: ["NOT_A_SKILL_HERE"] } }, base);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.issues).toEqual([
      expect.objectContaining({ severity: "error", path: "template.skills.0" }),
    ]);
    expect((await get()).json().overlay).toEqual({});
  });

  test("a broken template: schema-only, saved, no effects", async () => {
    await reset();
    const base = (await get()).json().version;
    writeFileSync(templateYaml(), "name: [broken\n");
    try {
      const view = (await get()).json();
      expect(view.template).toMatchObject({ name: "test", valid: false, doc: null });
      expect(view.merged).toBeNull();
      const r = await put({ template: { model: "opus" } }, base);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ checked: "schema", changes: [], restartChecked: false });
      // A schema error is still refused.
      const bad = await put({ template: { nope: 1 } }, r.json().version);
      expect(bad.statusCode).toBe(400);
    } finally {
      writeFileSync(templateYaml(), TEST_TEMPLATE_YAML);
    }
  });

  test("a spawned agent can't be configured", async () => {
    await t.seedAgent({ slug: "kid" });
    const [lead] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, "dev"));
    // A spawned agent always reports to its spawner (agents_manager).
    await t.db
      .update(schema.agents)
      .set({ kind: "ephemeral", reportsTo: lead?.id })
      .where(eq(schema.agents.slug, "kid"));
    const r = await put({}, overlayVersion({}), "kid");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("ephemeral_agent");
  });
});
