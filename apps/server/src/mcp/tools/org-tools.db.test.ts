import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { createFakeClaude } from "@open-factory/harness/testing";
import { type Actor, overlayVersion } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { insertAgent } from "../../agents/testing/rows.ts";
import { makeTestApp } from "../../test/helpers.ts";
import { seedTestUser } from "../../test/principals.ts";
import { callTool, mcpCall } from "../testing/mcp-client.ts";

// A secret reference as a config holds it, never expanded.
const REF = "$" + "{S}";
const SECRET = "sekrit-123";
const TOKEN = "sk-ant-oat01-xyz";
const NINE = [
  "get_agent",
  "create_agent",
  "update_agent",
  "archive_agent",
  "unarchive_agent",
  "list_templates",
  "get_template",
  "list_library",
  "list_org_resources",
];

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
const human: Actor = { kind: "human", handle: "or" };
const tok: Record<string, string> = {};
const row = async (slug: string) => {
  const [r] = await t.db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
  if (!r) throw new Error(`no agent ${slug}`);
  return r;
};
const writeTemplate = (name: string, extra = "") => {
  const d = path.join(t.factoryHome, "templates", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "template.yaml"),
    `name: ${name}\ndisplay_name: ${name}\nruntime: docker\n${extra}`,
  );
  writeFileSync(path.join(d, "AGENTS.md"), `# ${name}\n`);
  return d;
};
const body = (slug: string) => ({
  template: "dev",
  slug,
  displayName: slug,
  description: "",
  reportsTo: "or",
  credential: "work",
});
const call = async (who: string, name: string, args: object) => {
  const r = await callTool(url, tok[who] as string, name, args);
  const text = r.content[0]?.text ?? "";
  return { err: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
};
const names = async (who: string) =>
  (
    (await mcpCall(url, tok[who] as string, "tools/list", {})).json.result.tools as {
      name: string;
    }[]
  ).map((x) => x.name);
const configEvents = async (slug: string) =>
  (
    await t.sql`select 1 from session_events where agent_id = ${(await row(slug)).id} and type = 'config_changed'`
  ).length;

beforeAll(async () => {
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: createFakeClaude({ scenario: "reply" }).bin },
  });
  url = `http://127.0.0.1:${t.app.agentListener.port}`;
  await seedTestUser(t.db, "or");
  const credId = randomUUID();
  await t.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: t.app.vault.seal(TOKEN, `credentials:${credId}`),
  });
  await t.app.secrets.put("S", SECRET);
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  await t.app.projects.create({ name: "site", hostPath: repo });
  writeTemplate("dev", `secrets:\n  - S\n`);
  writeTemplate("lead");
  await t.app.templates.scan();
  await t.app.agents.create(body("hr-bot"), human);
  await t.app.agents.update("hr-bot", { manageOrg: true }, human);
  await t.app.agents.create(body("plain"), human);
  await t.app.agents.create(body("dev-1"), human);
  for (const s of ["hr-bot", "plain"]) tok[s] = t.app.agentTokens.mint((await row(s)).id).token;
});
afterAll(() => t.close());

test("only a manage_org caller lists the nine org tools", async () => {
  const plain = await names("plain");
  for (const n of NINE) expect(plain).not.toContain(n);
  const hr = await names("hr-bot");
  for (const n of NINE) expect(hr).toContain(n);
});

test("a flag turned off after tools/list makes the call an unknown-tool error", async () => {
  await t.app.agents.create(body("temp"), human);
  await t.app.agents.update("temp", { manageOrg: true }, human);
  tok.temp = t.app.agentTokens.mint((await row("temp")).id).token;
  expect(await names("temp")).toContain("get_agent");
  await t.app.agents.update("temp", { manageOrg: false }, human);
  const r = await mcpCall(url, tok.temp as string, "tools/call", {
    name: "get_agent",
    arguments: { slug: "hr-bot" },
  });
  expect(r.json.error).toMatchObject({ code: -32602, message: "Tool get_agent not found" });
  expect(JSON.stringify(r.json)).not.toContain('"slug":"hr-bot"');
});

test("a handler reached with a revoked caller row refuses with the sentence", async () => {
  const { orgTools } = await import("./org-tools.ts");
  const revoked = { ...(await row("hr-bot")), manageOrg: false };
  const regs = orgTools({
    loadAgent: async () => revoked,
    agents: t.app.agents,
    config: t.app.configs,
    templates: t.app.templates,
    library: t.app.library,
    credentials: t.app.credentials,
    secrets: t.app.secrets,
    projects: t.app.projects,
    bus: t.app.bus,
  });
  let handler:
    | ((a: object, c: object) => Promise<{ isError?: boolean; content: { text: string }[] }>)
    | undefined;
  for (const r of regs)
    r.register({
      registerTool: (n: string, _c: unknown, h: typeof handler) => {
        if (n === "get_agent") handler = h;
      },
    } as never);
  const res = await handler?.({ slug: "plain" }, { http: { authInfo: { clientId: revoked.id } } });
  expect(res).toEqual({
    isError: true,
    content: [{ type: "text", text: "@hr-bot can't manage the org any more." }],
  });
});

const createArgs = (slug: string, extra: object = {}) => ({
  template: "dev",
  name: `@${slug}`,
  display_name: "C",
  description: "d",
  credential: "work",
  ...extra,
});

test.each([
  ["an agent with its @handle", "@hr-bot", "agent"],
  ["an agent with its bare name", "hr-bot", "agent"],
  ["a person with their @handle", "@or", "user"],
])("create_agent reports to %s", async (n, reports_to, kind) => {
  const slug = `c-${n.replace(/\W+/g, "-")}`;
  const r = await call("hr-bot", "create_agent", createArgs(slug, { reports_to }));
  expect(r.json).toMatchObject({
    slug,
    status: "created",
    note: `@${slug} is created and starts when it gets its first message.`,
  });
  const created = await row(slug);
  expect(created.reportsTo).toBe(kind === "agent" ? (await row("hr-bot")).id : null);
  expect(created.reportsToUser).toBe(kind === "user" ? "u-or" : null);
  expect(created.manageOrg).toBe(false);
});

test("create_agent without reports_to is refused and creates nothing", async () => {
  const r = await call("hr-bot", "create_agent", createArgs("no-boss"));
  expect(r.err).toBe(true);
  expect(r.text).toContain("reports_to");
  expect(await t.sql`select 1 from agents where slug = 'no-boss'`).toHaveLength(0);
});

test("create_agent and update_agent refuse an unknown handle, a disabled person and a spawned agent as the manager", async () => {
  await seedTestUser(t.db, "off");
  await t.sql`update users set disabled_at = now() where id = (select id from principals where handle = 'off')`;
  await t.app.agents.create(body("kid-parent"), human);
  await insertAgent(t.sql, {
    id: "kid-id",
    slug: "kid-abcd",
    kind: "ephemeral",
    reportsTo: (await row("kid-parent")).id,
  });
  const refusal = "reports_to: Choose an active agent or person.";
  for (const reports_to of ["@ghost", "@off", "@kid-abcd"]) {
    expect(await call("hr-bot", "create_agent", createArgs("never", { reports_to }))).toMatchObject(
      { err: true, text: refusal },
    );
    expect(await call("hr-bot", "update_agent", { slug: "dev-1", reports_to })).toMatchObject({
      err: true,
      text: refusal,
    });
  }
  expect(await t.sql`select 1 from agents where slug = 'never'`).toHaveLength(0);
  expect((await row("dev-1")).reportsToUser).toBe("u-or");
  await t.sql`delete from agents where id = 'kid-id'`;
  await t.sql`delete from credentials where id = 'cred-kid-id'`;
});

test("update_agent moves an agent to a new manager and reports reports_to as changed; get_agent shows it", async () => {
  const r = await call("hr-bot", "update_agent", { slug: "dev-1", reports_to: "@plain" });
  expect(r.json).toMatchObject({ slug: "dev-1", changed: ["reports_to"] });
  const moved = await row("dev-1");
  expect(moved.reportsTo).toBe((await row("plain")).id);
  expect(moved.reportsToUser).toBeNull();
  expect((await call("hr-bot", "get_agent", { slug: "dev-1" })).json.reports_to).toBe("@plain");
  const back = await call("hr-bot", "update_agent", { slug: "dev-1", reports_to: "@or" });
  expect(back.json).toMatchObject({ changed: ["reports_to"] });
  expect((await call("hr-bot", "get_agent", { slug: "dev-1" })).json.reports_to).toBe("@or");
});

test("create_agent with a taken name returns the human sentence as name: …", async () => {
  const r = await call("hr-bot", "create_agent", {
    template: "dev",
    name: "plain",
    display_name: "P",
    description: "",
    reports_to: "@or",
    credential: "work",
  });
  expect(r).toMatchObject({ err: true, text: "name: That slug is taken." });
});

test("update_agent: config without base_hash is a schema error", async () => {
  const r = await call("hr-bot", "update_agent", { slug: "dev-1", config: {} });
  expect(r.err).toBe(true);
  expect(r.text).toContain("base_hash");
});

test("update_agent: a stale hash gives the Q14 sentence", async () => {
  const r = await call("hr-bot", "update_agent", { slug: "dev-1", config: {}, base_hash: "stale" });
  expect(r).toMatchObject({
    err: true,
    text: "@dev-1's configuration changed since you read it; call get_agent again.",
  });
});

test("update_agent: identity with an invalid config writes nothing", async () => {
  const before = await row("dev-1");
  const hash = overlayVersion(before.config as never);
  const r = await call("hr-bot", "update_agent", {
    slug: "dev-1",
    display_name: "Renamed",
    config: { settings: { hooks: { PreToolUse: [] } } },
    base_hash: hash,
  });
  expect(r.err).toBe(true);
  expect(r.text).toMatch(/hooks/);
  const after = await row("dev-1");
  expect(after.displayName).toBe(before.displayName);
  expect(after.config).toEqual(before.config);
});

test("update_agent: a valid identity patch with a stale base_hash writes nothing and emits nothing", async () => {
  const before = await row("dev-1");
  const events = await configEvents("dev-1");
  const spy = vi.spyOn(t.app.bus, "publishAll");
  try {
    const r = await call("hr-bot", "update_agent", {
      slug: "dev-1",
      display_name: "Nope",
      config: { template: { model: "opus" } },
      base_hash: "stale",
    });
    expect(r.err).toBe(true);
    const after = await row("dev-1");
    expect(after.displayName).toBe(before.displayName);
    expect(after.config).toEqual(before.config);
    expect(await configEvents("dev-1")).toBe(events);
    expect(
      spy.mock.calls.filter(([m]) => m.type === "org_action" || m.type === "config_changed"),
    ).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("update_agent: identity and config together write both and list the changes", async () => {
  const hash = overlayVersion((await row("dev-1")).config as never);
  const r = await call("hr-bot", "update_agent", {
    slug: "dev-1",
    display_name: "Developer One",
    config: { template: { model: "opus" } },
    base_hash: hash,
  });
  expect(r.err).toBe(false);
  expect(r.json.slug).toBe("dev-1");
  expect(r.json.changed.slice(0, 2)).toEqual(["display_name", "config"]);
  expect(r.json.changed.length).toBeGreaterThan(2);
  expect(r.json.restart).toBe(false);
  const after = await row("dev-1");
  expect(after.displayName).toBe("Developer One");
  expect(after.config).toEqual({ template: { model: "opus" } });
  expect(await configEvents("dev-1")).toBeGreaterThan(0);
});

test("get_agent: overlay_hash is the overlay version, references stay literal, credential and projects are names", async () => {
  await t.app.agents.update("dev-1", { projects: ["site"] }, human);
  await t.app.configs.saveOverlay(
    "dev-1",
    {
      template: { model: "opus" },
      settings: {
        env: { GH: REF },
      },
    },
    overlayVersion((await row("dev-1")).config as never),
    human,
  );
  const r = await call("hr-bot", "get_agent", { slug: "@dev-1" });
  const stored = (await row("dev-1")).config;
  expect(r.json.overlay_hash).toBe(overlayVersion(stored as never));
  expect(JSON.stringify(r.json.effective)).toContain(REF);
  expect(r.json.effective.template).not.toHaveProperty("local_skill_names");
  expect(r.json).toMatchObject({
    credential: "work",
    projects: ["site"],
    manage_org: false,
    kind: "persistent",
  });
});

test("an agent editing its own description gets its restart with wake; another agent's edit does not", async () => {
  const spy = vi.spyOn(t.app.runtimes, "requestRestart");
  try {
    const hrId = (await row("hr-bot")).id;
    expect((await call("hr-bot", "update_agent", { slug: "hr-bot", description: "me" })).err).toBe(
      false,
    );
    expect(spy).toHaveBeenCalledWith(hrId, { wake: true });
    spy.mockClear();
    expect((await call("hr-bot", "update_agent", { slug: "dev-1", description: "you" })).err).toBe(
      false,
    );
    expect(spy.mock.calls.filter(([, o]) => o?.wake)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("get_template returns files with hashes, and a linked file as an error", async () => {
  const dir = writeTemplate("linked");
  writeFileSync(path.join(dir, "real.json"), "{}");
  symlinkSync(path.join(dir, "real.json"), path.join(dir, "settings.json"));
  await t.app.templates.scan();
  const r = await call("hr-bot", "get_template", { name: "linked" });
  expect(r.json.files["settings.json"]).toEqual({ error: "settings.json is a link; ask a human." });
  expect(r.json.files["template.yaml"]).toMatchObject({
    content: expect.stringContaining("linked"),
    hash: expect.any(String),
  });
  expect(r.json.files["mcp.json"]).toBeNull();
  expect(r.json.agents).toEqual({ live: [], archived: [] });
  expect(r.text).not.toContain(t.factoryHome);
});

test("list_templates lists name, display name, validity and agent count", async () => {
  const r = await call("hr-bot", "list_templates", {});
  expect(r.json).toContainEqual({
    name: "dev",
    display_name: "dev",
    description: "",
    valid: true,
    agents: expect.any(Number),
  });
});

test("archive_agent and unarchive_agent follow the human rules; self-archive is refused", async () => {
  expect((await call("hr-bot", "archive_agent", { slug: "hr-bot" })).text).toBe(
    "Ask a human to archive you.",
  );
  expect((await call("hr-bot", "archive_agent", { slug: "plain" })).json).toMatchObject({
    slug: "plain",
    archived: true,
  });
  expect((await row("plain")).archivedAt).not.toBeNull();
  expect((await call("hr-bot", "unarchive_agent", { slug: "plain" })).json).toMatchObject({
    slug: "plain",
    archived: false,
  });
  expect((await row("plain")).archivedAt).toBeNull();
});

test("list_library: sources are kinds, host paths are not, 201 skills set more", async () => {
  for (let i = 0; i < 201; i++) {
    const d = path.join(t.hostSkillsDir, `skill-${i}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: skill-${i}\ndescription: bulk skill\n---\nBody\n`,
    );
  }
  const many = await call("hr-bot", "list_library", { query: "bulk" });
  expect(many.json.skills).toHaveLength(200);
  expect(many.json.more).toBe(true);
  expect(many.json.skills[0]).toMatchObject({ source: "host" });
  expect(many.text).not.toContain(t.hostSkillsDir);
});

test("list_org_resources has names only and no host paths", async () => {
  const r = await call("hr-bot", "list_org_resources", {});
  expect(r.json).toEqual({
    credentials: [{ name: "work", kind: "oauth_token" }],
    secrets: [{ name: "S", used_by: expect.any(Number) }],
    projects: [{ name: "site" }],
  });
  expect(r.text).not.toContain("hostPath");
  expect(r.text).not.toContain(tmpdir());
});

test("no tool result holds a secret value, a credential token or a host path (AC 6)", async () => {
  // [tool, args, expectError]: only the last two calls are meant to fail; every other call must succeed.
  const calls: [string, object, boolean][] = [
    ["list_templates", {}, false],
    ["get_template", { name: "dev" }, false],
    ["get_agent", { slug: "dev-1" }, false],
    ["get_agent", { slug: "hr-bot" }, false],
    [
      "create_agent",
      {
        template: "dev",
        name: "scan-1",
        display_name: "S",
        description: "",
        reports_to: "@or",
        credential: "work",
        projects: ["site"],
      },
      false,
    ],
    ["update_agent", { slug: "scan-1", description: "changed" }, false],
    ["archive_agent", { slug: "scan-1" }, false],
    ["unarchive_agent", { slug: "scan-1" }, false],
    ["list_library", {}, false],
    ["list_org_resources", {}, false],
    ["get_agent", { slug: "nobody" }, true],
    [
      "create_agent",
      {
        template: "dev",
        name: "scan-1",
        display_name: "S",
        description: "",
        reports_to: "@or",
        credential: "work",
      },
      true,
    ],
  ];
  const repo = (await t.sql`select host_path from projects`)[0]?.host_path as string;
  for (const [name, args, expectError] of calls) {
    const r = await call("hr-bot", name, args);
    expect(r.err, `${name} ${expectError ? "should have failed" : `failed: ${r.text}`}`).toBe(
      expectError,
    );
    for (const bad of [SECRET, TOKEN, t.factoryHome, t.config.hostClaudeDir, homedir(), repo])
      expect(r.text, `${name} leaked ${bad}`).not.toContain(bad);
  }
  // A project whose folder is gone: the materialize failure names no host path to the agent.
  rmSync(repo, { recursive: true, force: true });
  const gone = await call("hr-bot", "create_agent", {
    template: "dev",
    name: "scan-2",
    display_name: "S",
    description: "",
    reports_to: "@or",
    credential: "work",
    projects: ["site"],
  });
  expect(gone.err).toBe(true);
  for (const bad of [t.factoryHome, homedir(), repo, tmpdir()])
    expect(gone.text, `missing folder leaked ${bad}`).not.toContain(bad);
});

test("updateWithOverlay: an overlay changed after validation rolls the identity patch back and emits nothing", async () => {
  const hr: Actor = { kind: "agent", id: (await row("hr-bot")).id, slug: "hr-bot" };
  const before = await row("dev-1");
  const plan = await t.app.configs.planOverlay(
    "dev-1",
    { template: { model: "haiku" } },
    overlayVersion(before.config as never),
    hr,
  );
  const eventsBeforeSave = await configEvents("dev-1");
  // A human saves in the window between validation and the transaction.
  await t.app.configs.saveOverlay(
    "dev-1",
    { template: { model: "sonnet" } },
    overlayVersion(before.config as never),
    human,
  );
  // The save's own `config_changed` line is appended through the agent's runtime after the call returns:
  // wait for it, so only the rolled-back patch is measured below.
  await vi.waitFor(async () => expect(await configEvents("dev-1")).toBe(eventsBeforeSave + 1));
  const events = eventsBeforeSave + 1;
  const spy = vi.spyOn(t.app.bus, "publishAll");
  try {
    await expect(
      t.app.agents.updateWithOverlay("dev-1", { displayName: "Half written" }, plan, hr),
    ).rejects.toThrow("@dev-1's configuration changed since you read it; call get_agent again.");
    const after = await row("dev-1");
    expect(after.displayName).toBe(before.displayName);
    expect(after.config).toEqual({ template: { model: "sonnet" } });
    expect(await configEvents("dev-1")).toBe(events);
    expect(spy.mock.calls.filter(([m]) => m.type === "org_action")).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("create_agent refuses an unknown ref as the manager with the fix-it sentence and creates nothing", async () => {
  const r = await call(
    "hr-bot",
    "create_agent",
    createArgs("ghosted", { reports_to: "<@zzzzzzzz>" }),
  );
  expect(r.err).toBe(true);
  expect(r.text).toBe(
    "<@zzzzzzzz> isn't anyone in this factory; list_peers shows each agent and human with their tag.",
  );
  expect(await t.sql`select 1 from agents where slug = 'ghosted'`).toHaveLength(0);
});

test("create_agent and get_agent warn on a plain handle and stay quiet for a tag", async () => {
  const [boss] = await t.sql`select ref from principals where handle = 'hr-bot'`;
  const warning = `Plain tag detected: @hr-bot was resolved to <@${boss?.ref}|hr-bot>. Tag as <@ref|handle>.`;
  const plain = await call(
    "hr-bot",
    "create_agent",
    createArgs("warned", { reports_to: "hr-bot" }),
  );
  expect(plain.json.warnings).toEqual([warning]);
  const tagged = await call(
    "hr-bot",
    "create_agent",
    createArgs("not-warned", { reports_to: `<@${boss?.ref}>` }),
  );
  expect(tagged.json).not.toHaveProperty("warnings");
  expect((await call("hr-bot", "get_agent", { slug: "hr-bot" })).json.warnings).toEqual([warning]);
  expect((await call("hr-bot", "get_agent", { slug: `<@${boss?.ref}>` })).json).not.toHaveProperty(
    "warnings",
  );
});
