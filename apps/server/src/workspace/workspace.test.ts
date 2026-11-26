import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { FieldError } from "../errors.ts";
import { hostOnlyLibrary, writeHostSkill } from "../test/library.ts";
import { KeyedMutex } from "./lock.ts";
import { Workspace } from "./workspace.ts";

function setup(fakeEnv: Record<string, string> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "of-"));
  const claude = mkdtempSync(path.join(tmpdir(), "claude-"));
  const hs = path.join(claude, "skills");
  writeHostSkill(claude, "grilling");
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  const tdir = path.join(home, "templates/lead");
  mkdirSync(path.join(tdir, "skills/local"), { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
  writeFileSync(path.join(tdir, "skills/local/SKILL.md"), "s");
  const config = templateYamlSchema.parse({
    name: "lead",
    display_name: "Lead",
    runtime: "local",
    skills: ["grilling"],
    projects: ["app"],
  });
  const tplSettings = {
    permissions: { deny: ["Bash(curl:*)"] },
  };
  const _fake = createFakeClaude({ scenario: "reply", env: fakeEnv });
  const ws = new Workspace({
    factoryHome: home,
    library: hostOnlyLibrary(claude, home),
    cliBundle: "/nonexistent/open-factory.js",
    lock: new KeyedMutex(),
  });
  const tpl = { dir: tdir, config, tplSettings, tplMcp: { mcpServers: { x: { command: "x" } } } };
  const prep = {
    slug: "lead",
    self: { ref: "p3dh8vcn", handle: "lead" },
    displayName: "Lead",
    description: "d",
    template: "lead",
    config,
    effective: {
      doc: { template: {}, settings: tplSettings, mcp: tpl.tplMcp },
      config,
      templateSkills: [],
      library: { skills: {} },
    },
    manager: { kind: "human" as const, ref: "k7x2m9qd", handle: "or", name: "Or" },
    grants: [{ name: "app", hostPath: repo }],
    peers: [],
    reports: [],
    humans: [],
    mcpUrl: "http://127.0.0.1:3001/mcp",
    kind: "persistent" as const,
    spawner: null,
    spawning: false,
    secretNames: config.secrets,
    manageOrg: false,
    descriptionWrittenBy: null,
    memberUpdateSeconds: 30,
  };
  return { home, hs, claude, repo, ws, tpl, prep };
}

test("materialize then prepare: the full layout", async () => {
  const { ws, tpl, prep, repo, hs, home } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, ".claude/skills"))).toBe(false); // linked at start, never copied
  expect(existsSync(path.join(wd, "projects"))).toBe(false); // check-only at creation
  const out = await ws.prepare(prep);
  expect(readlinkSync(path.join(wd, ".claude/skills/local"))).toBe(
    realpathSync(path.join(home, "templates/lead/skills/local")),
  );
  expect(lstatSync(path.join(wd, "projects/app")).isSymbolicLink()).toBe(true);
  expect(lstatSync(path.join(wd, ".claude/skills/grilling")).isSymbolicLink()).toBe(true);
  const s = JSON.parse(readFileSync(path.join(wd, ".claude-config/settings.json"), "utf8"));
  expect(s.permissions.additionalDirectories).toEqual([repo]);
  expect(s.permissions.deny).toEqual(["Bash(curl:*)", "SendMessage", "ListAgents"]);
  expect(JSON.parse(readFileSync(path.join(wd, ".mcp.json"), "utf8"))).toEqual({
    mcpServers: {
      x: { command: "x" },
      factory: {
        type: "http",
        url: "http://127.0.0.1:3001/mcp",
        headers: { Authorization: "Bearer ${OPEN_FACTORY_AGENT_TOKEN}" },
      },
    },
  });
  expect(readFileSync(path.join(wd, ".claude-config/CLAUDE.md"), "utf8")).toContain(
    "<@p3dh8vcn|lead>",
  );
  expect(out.mounts.map((m) => m.target)).toEqual([
    wd,
    repo,
    realpathSync(path.join(hs, "grilling")),
    realpathSync(path.join(home, "templates/lead/skills/local")),
    "/opt/factory/bin/open-factory",
  ]);
});

test("prepare drops agent-added settings keys and re-asserts template rules", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  await ws.prepare(prep);
  const f = path.join(ws.workdir("lead"), ".claude-config/settings.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  s.permissions.deny = [];
  s.mine = 1;
  writeFileSync(f, JSON.stringify(s));
  await ws.prepare(prep);
  const again = JSON.parse(readFileSync(f, "utf8"));
  expect(again.permissions.deny).toEqual(["Bash(curl:*)", "SendMessage", "ListAgents"]);
  expect(again).not.toHaveProperty("mine");
});

test("materialize: an existing folder is folder_exists and left alone; the caller can discard its own", async () => {
  const { ws, tpl, prep, home } = setup();
  mkdirSync(path.join(home, "agents/taken"), { recursive: true });
  await expect(
    ws.materialize("taken", "taken", tpl, { ...prep, slug: "taken" }),
  ).rejects.toBeInstanceOf(FieldError);
  expect(existsSync(path.join(home, "agents/taken"))).toBe(true);
  await ws.materialize("lead", "lead", tpl, prep);
  await ws.discard("lead");
  expect(existsSync(path.join(home, "agents/lead"))).toBe(false);
});

const STAMP = /^state\/agents\/lead\/persona\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const tplMd = (tpl: { dir: string }) => path.join(tpl.dir, "AGENTS.md");

test("resetPersona backs up a differing AGENTS.md, writes the template's and never deletes", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  writeFileSync(path.join(wd, "AGENTS.md"), "# Lead\nlearned things\n");
  writeFileSync(path.join(wd, "mine.md"), "keep");
  const r = await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true });
  expect(r.applied).toBe("now");
  expect(r.backupDir).toMatch(STAMP);
  expect(readFileSync(path.join(home, r.backupDir as string, "AGENTS.md"), "utf8")).toContain(
    "learned",
  );
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, "mine.md"))).toBe(true);
  // Nothing differs now: no backup.
  expect(r.changed).toBe(true);
  expect(await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true })).toEqual({
    applied: "now",
    changed: false,
  });
  // A deleted AGENTS.md is recreated: a change, with nothing to save.
  rmSync(path.join(wd, "AGENTS.md"));
  expect(await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true })).toEqual({
    applied: "now",
    changed: true,
  });
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
});

test("resetPersona backs a symlinked AGENTS.md up as a link and replaces it, never writing through", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  const secret = path.join(mkdtempSync(path.join(tmpdir(), "secret-")), "id_ed25519");
  writeFileSync(secret, "PRIVATE KEY");
  rmSync(path.join(wd, "AGENTS.md"));
  symlinkSync(secret, path.join(wd, "AGENTS.md"));
  const r = await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true });
  const backup = path.join(home, r.backupDir as string, "AGENTS.md");
  expect(lstatSync(backup).isSymbolicLink()).toBe(true);
  expect(readlinkSync(backup)).toBe(secret);
  expect(lstatSync(path.join(wd, "AGENTS.md")).isFile()).toBe(true);
  expect(readFileSync(secret, "utf8")).toBe("PRIVATE KEY");
});

test("resetPersona refuses a workdir that is a symlink", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  const host = mkdtempSync(path.join(tmpdir(), "host-"));
  rmSync(wd, { recursive: true });
  symlinkSync(host, wd);
  await expect(ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true })).rejects.toThrow(
    /symlink/,
  );
  expect(existsSync(path.join(host, "AGENTS.md"))).toBe(false);
});

test("a staged persona reset leaves the workdir alone until prepare applies it, then removes the file", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  writeFileSync(path.join(wd, "AGENTS.md"), "edited");
  const r = await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: false });
  expect(r).toEqual({ applied: "on_restart", changed: true });
  const pending = path.join(home, "state/agents/lead/persona-pending/AGENTS.md");
  expect(readFileSync(pending, "utf8")).toBe("# Lead\n");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("edited");
  await ws.prepare(prep);
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.dirname(pending))).toBe(false);
  const root = path.join(home, "state/agents/lead/persona");
  const [stamp] = readdirSync(root);
  expect(readFileSync(path.join(root, stamp as string, "AGENTS.md"), "utf8")).toBe("edited");
});

test("a failing apply at prepare keeps the pending file; a later write-now reset supersedes it", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: false });
  rmSync(path.join(wd, "AGENTS.md"));
  mkdirSync(path.join(wd, "AGENTS.md")); // not a file: the backup refuses
  await expect(ws.prepare(prep)).rejects.toThrow(/isn't a file/);
  const pending = path.join(home, "state/agents/lead/persona-pending/AGENTS.md");
  expect(existsSync(pending)).toBe(true);
  rmSync(path.join(wd, "AGENTS.md"), { recursive: true });
  writeFileSync(tplMd(tpl), "# Newer\n");
  await ws.resetPersona("lead", tplMd(tpl), { canWriteNow: true });
  expect(existsSync(pending)).toBe(false);
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Newer\n");
});

test("prepare treats a non-object previous settings.json like a parse failure", async () => {
  for (const bad of ["null", "[1,2]", "7", "{nope"]) {
    const { ws, tpl, prep } = setup();
    await ws.materialize("lead", "lead", tpl, prep);
    const sp = path.join(ws.workdir("lead"), ".claude-config/settings.json");
    writeFileSync(sp, bad);
    await ws.prepare(prep);
    const s = JSON.parse(readFileSync(sp, "utf8"));
    expect(s.permissions.deny).toEqual(["Bash(curl:*)", "SendMessage", "ListAgents"]);
  }
});

test("prepare writes the effective settings and mcp", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const effective = {
    ...prep.effective,
    doc: {
      ...prep.effective.doc,
      settings: {
        ...prep.effective.doc.settings,
        permissions: { deny: ["Bash(curl:*)", "Bash(rm:*)"] },
      },
      mcp: { mcpServers: { x: { command: "x" }, extra: { command: "y" } } },
    },
  };
  await ws.prepare({ ...prep, effective });
  const wd = ws.workdir("lead");
  const s = JSON.parse(readFileSync(path.join(wd, ".claude-config/settings.json"), "utf8"));
  expect(s.permissions.deny).toEqual(["Bash(curl:*)", "Bash(rm:*)", "SendMessage", "ListAgents"]);
  const mcp = JSON.parse(readFileSync(path.join(wd, ".mcp.json"), "utf8"));
  expect(Object.keys(mcp.mcpServers)).toEqual(["x", "extra", "factory"]);
});

test(".mcp.json gets the factory server with an env-expanded header and no secret", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  await ws.prepare({ ...prep, mcpUrl: "http://host.docker.internal:3001/mcp" });
  const raw = readFileSync(path.join(ws.workdir("lead"), ".mcp.json"), "utf8");
  expect(JSON.parse(raw).mcpServers.factory).toEqual({
    type: "http",
    url: "http://host.docker.internal:3001/mcp",
    headers: { Authorization: "Bearer ${OPEN_FACTORY_AGENT_TOKEN}" },
  });
});

test("a template skill is live: edits show at once, a removed one's link goes, local_skills off drops them", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  await ws.prepare(prep);
  writeFileSync(path.join(home, "templates/lead/skills/local/SKILL.md"), "edited");
  expect(readFileSync(path.join(wd, ".claude/skills/local/SKILL.md"), "utf8")).toBe("edited");
  await ws.prepare({
    ...prep,
    effective: { ...prep.effective, config: { ...prep.effective.config, localSkills: false } },
  });
  expect(existsSync(path.join(wd, ".claude/skills/local"))).toBe(false);
  await ws.prepare(prep);
  rmSync(path.join(home, "templates/lead/skills/local"), { recursive: true });
  await ws.prepare(prep);
  expect(existsSync(path.join(wd, ".claude/skills/local"))).toBe(false);
});

test("prepare refuses a symlinked template skill and a symlinked skills/ folder", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  const skills = path.join(home, "templates/lead/skills");
  symlinkSync(outside, path.join(skills, "evil"));
  await expect(ws.prepare(prep)).rejects.toThrow("skills/evil must be a folder, not a link.");
  rmSync(skills, { recursive: true });
  symlinkSync(outside, skills);
  await expect(ws.prepare(prep)).rejects.toThrow("skills/ must be a folder, not a link.");
});

test("materialize refuses a skill the Library can't resolve, with the start's message", async () => {
  const { ws, tpl, prep } = setup();
  const missing = { ...prep, config: { ...prep.config, skills: ["nope"] } };
  await expect(ws.materialize("lead", "lead", tpl, missing)).rejects.toMatchObject({
    name: "WorkspaceError",
    message: "Skill nope hasn't been added in Skills. Fix it in Configuration.",
    fix: "config",
  });
});

test("prepare resolves a skill through the Library, so an unresolvable one fails the start too", async () => {
  const { ws, tpl, prep, claude } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  rmSync(path.join(claude, "skills/grilling/SKILL.md"));
  await expect(ws.prepare(prep)).rejects.toMatchObject({
    message: "Skill grilling hasn't been added in Skills. Fix it in Configuration.",
  });
});

test("prepare checks and scrubs the agent's own folders after linking", async () => {
  const { ws, tpl, prep, claude } = setup();
  writeHostSkill(claude, "hooked", "hooks:\n  PreToolUse: []\n");
  const withHooked = {
    ...prep,
    effective: {
      ...prep.effective,
      config: { ...prep.effective.config, skills: ["grilling", "hooked"] },
    },
  };
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  mkdirSync(path.join(wd, ".claude-config/skills/stale"), { recursive: true });
  // A Library skill that declares hooks is human-registered: it starts.
  await ws.prepare(withHooked);
  expect(readdirSync(path.join(wd, ".claude-config/skills"))).toEqual([]);

  writeFileSync(path.join(wd, ".claude/settings.local.json"), JSON.stringify({ hooks: {} }));
  await expect(ws.prepare(withHooked)).rejects.toThrow(
    `${path.join(wd, ".claude/settings.local.json")} sets hooks, which agents can't set; remove it.`,
  );
  rmSync(path.join(wd, ".claude/settings.local.json"));

  mkdirSync(path.join(wd, ".claude/agents"), { recursive: true });
  writeFileSync(path.join(wd, ".claude/agents/a.md"), "---\nmcpServers: {}\n---\n");
  await expect(ws.prepare(withHooked)).rejects.toThrow("agents/a.md declares mcpServers");
});

test("prepare names the template as the fix for a skill the template lists, the agent for one it added", async () => {
  const { ws, tpl, prep, claude } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  rmSync(path.join(claude, "skills/grilling/SKILL.md"));
  const listed = { ...prep, effective: { ...prep.effective, templateSkills: ["grilling"] } };
  await expect(ws.prepare(listed)).rejects.toMatchObject({ fix: "template" });
  await expect(ws.prepare(prep)).rejects.toMatchObject({ fix: "config" });
  await expect(
    ws.materialize(
      "lead2",
      "lead2",
      { ...tpl, config: { ...tpl.config, skills: ["grilling"] } },
      {
        ...prep,
        slug: "lead2",
      },
    ),
  ).rejects.toMatchObject({ fix: "template" });
});

test("prepare reports the first failing step when two coexist: the settings check, then the agents check", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  mkdirSync(path.join(wd, ".claude/agents"), { recursive: true });
  writeFileSync(path.join(wd, ".claude/settings.local.json"), JSON.stringify({ hooks: {} }));
  writeFileSync(path.join(wd, ".claude/agents/a.md"), "---\nhooks: {}\n---\n");
  await expect(ws.prepare(prep)).rejects.toThrow("sets hooks");
  rmSync(path.join(wd, ".claude/settings.local.json"));
  await expect(ws.prepare(prep)).rejects.toThrow("agents/a.md declares hooks");
});
