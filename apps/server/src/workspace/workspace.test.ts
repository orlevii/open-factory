import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { KeyedMutex } from "./lock.ts";
import { Workspace } from "./workspace.ts";

function setup(fakeEnv: Record<string, string> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "of-"));
  const hs = mkdtempSync(path.join(tmpdir(), "hs-"));
  mkdirSync(path.join(hs, "grilling"));
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
    plugins: ["p@mk"],
    projects: ["app"],
  });
  const tplSettings = {
    extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/mk" } } },
    permissions: { deny: ["Bash(curl:*)"] },
  };
  const fake = createFakeClaude({ scenario: "reply", env: fakeEnv });
  const ws = new Workspace({
    factoryHome: home,
    hostSkillsDir: hs,
    claudeBin: fake.bin,
    cliBundle: "/nonexistent/open-factory.js",
    lock: new KeyedMutex(),
  });
  const tpl = { dir: tdir, config, tplSettings, tplMcp: { mcpServers: { x: { command: "x" } } } };
  const prep = {
    slug: "lead",
    displayName: "Lead",
    description: "d",
    template: "lead",
    config,
    effective: { doc: { template: {}, settings: tplSettings, mcp: tpl.tplMcp }, config },
    manager: null,
    grants: [{ name: "app", hostPath: repo }],
    peers: [],
    reports: [],
    humans: [],
    mcpUrl: "http://127.0.0.1:3001/mcp",
    kind: "persistent" as const,
    spawner: null,
    spawning: null,
    secretNames: config.secrets,
  };
  return { home, hs, repo, ws, tpl, prep };
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
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
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
  expect(readFileSync(path.join(wd, ".claude-config/CLAUDE.md"), "utf8")).toContain("@lead");
  expect(out.mounts.map((m) => m.target)).toEqual([
    wd,
    repo,
    realpathSync(path.join(hs, "grilling")),
    realpathSync(path.join(home, "templates/lead/skills/local")),
    "/mk",
    path.join(home, "state/agents/lead/plugins-config/plugins"),
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
  expect(again.enabledPlugins).toEqual({ "p@mk": true });
});

test("materialize: existing folder → folder_exists; plugin failure → caller can discard", async () => {
  const { ws, tpl, prep, home } = setup({ FAKE_CLAUDE_PLUGIN_FAIL: "p@mk" });
  mkdirSync(path.join(home, "agents/taken"), { recursive: true });
  await expect(
    ws.materialize("taken", "taken", tpl, { ...prep, slug: "taken" }),
  ).rejects.toBeInstanceOf(FieldError);
  expect(existsSync(path.join(home, "agents/taken"))).toBe(true);
  await expect(ws.materialize("lead", "lead", tpl, prep)).rejects.toThrow(/Plugin install failed/);
  await ws.discard("lead");
  expect(existsSync(path.join(home, "agents/lead"))).toBe(false);
});

test("resync backs up differing files and never deletes", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  writeFileSync(path.join(wd, "AGENTS.md"), "# Lead\nlearned things\n");
  writeFileSync(path.join(wd, "mine.md"), "keep");
  const dir = (await ws.resync("lead", tpl, { canWriteNow: true })).backupDir;
  expect(dir).toMatch(/^state\/agents\/lead\/resync\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  expect(readFileSync(path.join(home, dir as string, "AGENTS.md"), "utf8")).toContain("learned");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, "mine.md"))).toBe(true);
  expect((await ws.resync("lead", tpl, { canWriteNow: true })).backupDir).toBeUndefined();
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

test("prepare writes the effective settings and mcp, never the state template copy", async () => {
  const { home, ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const copy = path.join(home, "state/agents/lead/template");
  writeFileSync(path.join(copy, "settings.json"), "{nope");
  rmSync(path.join(copy, "mcp.json"));
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
