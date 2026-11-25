import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { createFakeClaude, type FakeScenario } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { buildAgentEnv } from "../agents/runtime-spec.ts";
import { FieldError } from "../errors.ts";
import { hostOnlyLibrary, marketplaceRow, writeHostSkill } from "../test/library.ts";
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
  const fake = createFakeClaude({ scenario: "reply", env: fakeEnv });
  const ws = new Workspace({
    factoryHome: home,
    library: hostOnlyLibrary(claude, home),
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
    effective: {
      doc: { template: {}, settings: tplSettings, mcp: tpl.tplMcp },
      config,
      templateSkills: [],
      library: { skills: {}, plugins: {} },
    },
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
    manageOrg: false,
    descriptionWrittenBy: null,
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
  expect(s).not.toHaveProperty("enabledPlugins");
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
    realpathSync(path.join(home, "state/agents/lead/plugins")),
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

test("materialize creates no plugins dir; a start creates it and nothing else for plugins (spec §7.2)", async () => {
  const { ws, tpl, prep, home } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const state = path.join(home, "state/agents/lead");
  expect(existsSync(path.join(state, "plugins"))).toBe(false);
  const before = new Set(existsSync(state) ? readdirSync(state) : []);
  const out = await ws.prepare(prep);
  expect(out.plugins.dir).toBe(realpathSync(path.join(state, "plugins")));
  expect(readdirSync(path.join(state, "plugins"))).toEqual([]);
  // The only additions are the dir and the `--settings` file; no installer state and no second plugins tree.
  const added = readdirSync(state).filter((n) => !before.has(n));
  expect(added).toContain("plugins");
  expect(added.filter((n) => !["plugin-settings.json", "plugins"].includes(n))).toEqual([]);
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

  mkdirSync(path.join(wd, ".claude/skills/p/.claude-plugin"), { recursive: true });
  await expect(ws.prepare(withHooked)).rejects.toThrow(
    "skills/p is a plugin, so it can't load as a skill; move it away.",
  );
  rmSync(path.join(wd, ".claude/skills/p"), { recursive: true });

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

test("prepare reports the first failing step when two coexist: the plugin check, then the settings check", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  mkdirSync(path.join(wd, ".claude/skills/p/.claude-plugin"), { recursive: true });
  writeFileSync(path.join(wd, ".claude/settings.local.json"), JSON.stringify({ hooks: {} }));
  mkdirSync(path.join(wd, ".claude/agents"), { recursive: true });
  writeFileSync(path.join(wd, ".claude/agents/a.md"), "---\nhooks: {}\n---\n");
  await expect(ws.prepare(prep)).rejects.toThrow("skills/p is a plugin");
  rmSync(path.join(wd, ".claude/skills/p"), { recursive: true });
  await expect(ws.prepare(prep)).rejects.toThrow("sets hooks");
  rmSync(path.join(wd, ".claude/settings.local.json"));
  await expect(ws.prepare(prep)).rejects.toThrow("agents/a.md declares hooks");
});

// Spec §7.3: Claude Code installs the plugins at the start. The fake does what it does, from the `--settings` JSON and
// `CLAUDE_CODE_PLUGIN_CACHE_DIR` that `prepare` returns and `buildAgentEnv` turns into env.
type Prepared = Awaited<ReturnType<Workspace["prepare"]>>;
const GIT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, ...GIT },
    encoding: "utf8",
  }).trim();

/** A marketplace `mk` with the plugins `p` (needs `dep` when `dependsOn`) and `other`, at `version`. */
function writeMarketplace(root: string, version: string, dependsOn?: string[]) {
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "mk",
      plugins: ["p", "other", "dep"].map((name) => ({ name, source: `./plugins/${name}` })),
    }),
  );
  for (const name of ["p", "other", "dep"]) {
    const dir = path.join(root, "plugins", name, ".claude-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name,
        version: name === "p" ? version : "1.0.0",
        ...(name === "p" && dependsOn ? { dependencies: dependsOn } : {}),
      }),
    );
  }
}

const INIT_SCENARIO: FakeScenario = {
  onStart: [{ emit: { fixture: "ancestor-agents-md-loads", lines: [1, 1] } }],
  onUser: [],
};

type Decl = { source: Record<string, unknown> };

function pluginSetup(o: { fakeEnv?: Record<string, string>; enabled?: string[] } = {}) {
  const base = setup();
  const home = realpathSync(base.home);
  const root = mkdtempSync(path.join(tmpdir(), "of-plug-"));
  // `o/r` as a GitHub repo with 1.0.0 then 2.0.0; each commit's tree is also the Library's checkout of it.
  const gh = path.join(root, "gh");
  const repo = path.join(gh, "o", "r.git");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet", "-b", "main");
  const commits: string[] = [];
  for (const v of ["1.0.0", "2.0.0"]) {
    writeMarketplace(repo, v);
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", `v${v}`);
    const sha = git(repo, "rev-parse", "HEAD");
    commits.push(sha);
    cpSync(repo, path.join(home, "state/library/marketplaces/mk", sha), {
      recursive: true,
      filter: (f) => path.basename(f) !== ".git",
    });
  }
  const [c1, c2] = commits as [string, string];
  const local = path.join(root, "local");
  writeMarketplace(local, "1.0.0");
  const rows = (kind: "github" | "directory") => [
    kind === "github"
      ? marketplaceRow("mk", { source: "github", repo: "o/r" }, { commit: c2 })
      : marketplaceRow("mk", { source: "directory", path: local }),
  ];
  const fake = createFakeClaude({
    scenario: INIT_SCENARIO,
    env: { FAKE_CLAUDE_GITHUB_URL: `file://${gh}`, ...o.fakeEnv },
  });
  const ws = (kind: "github" | "directory" = "github") =>
    new Workspace({
      factoryHome: base.home,
      library: hostOnlyLibrary(base.claude, base.home, [], rows(kind)),
      claudeBin: fake.bin,
      cliBundle: "/nonexistent/open-factory.js",
      lock: new KeyedMutex(),
    });
  /** The prepare input for a template declaring `mk` as `decl` and enabling `enabled`. */
  const input = (decl: Decl, enabled = o.enabled ?? ["p@mk"], pin = "commit") => {
    const settings = {
      extraKnownMarketplaces: { mk: decl },
      enabledPlugins: Object.fromEntries(enabled.map((k) => [k, true])),
    };
    return {
      ...base.prep,
      effective: {
        ...base.prep.effective,
        doc: { ...base.prep.effective.doc, settings },
        library: { skills: {}, plugins: Object.fromEntries(enabled.map((k) => [k, pin])) },
      },
    };
  };
  const github = (ref?: string): Decl => ({
    source: { source: "github", repo: "o/r", ...(ref ? { ref } : {}) },
  });
  const directory: Decl = { source: { source: "directory", path: local } };
  /** Starts the fake the way the factory starts Claude: its env, and `--settings` from the prepare. */
  const run = (out: Prepared) => {
    const env = buildAgentEnv(
      { PATH: process.env.PATH },
      {
        configDir: out.configDir,
        slug: "lead",
        credential: { kind: "api_key", value: "k" },
        secrets: {},
        agentToken: "t",
        plugins: out.plugins,
      },
      "local",
    );
    const r = spawnSync(fake.bin, ["--settings", out.plugins.settingsJson], {
      input: "",
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    const init = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((x) => x.type === "system" && x.subtype === "init");
    return { env, init, stderr: r.stderr };
  };
  const installs = () => {
    const f = path.join(fake.dir, "plugin.log");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
  };
  return { ...base, home, c1, c2, ws, input, github, directory, run, installs, fake, local };
}

test("a cold start installs into state/agents/<slug>/plugins and init lists the plugin; a restart installs nothing", async () => {
  const x = pluginSetup();
  const ws = x.ws();
  const prep = x.input(x.github(x.c1));
  await ws.materialize("lead", "lead", x.tpl, prep);
  const out = await ws.prepare(prep);
  const dir = path.join(x.home, "state/agents/lead/plugins");
  expect(out.plugins.dir).toBe(dir);
  expect(existsSync(dir)).toBe(true);
  expect(out.plugins.expected).toEqual([{ key: "p@mk", pin: `commit:${x.c1}` }]);

  const first = x.run(out);
  expect(first.init.plugins).toEqual([
    { name: "p", path: path.join(dir, "cache/mk/p/1.0.0"), source: "p@mk", version: "1.0.0" },
  ]);
  expect(x.installs()).toEqual([`install p@mk ${x.c1} ${path.join(dir, "cache/mk/p/1.0.0")}`]);

  // The factory wrote nothing into the dir: Claude Code did.
  expect(existsSync(path.join(dir, "installed_plugins.json"))).toBe(true);
  const second = x.run(await ws.prepare(prep));
  expect(second.init.plugins).toHaveLength(1);
  expect(x.installs()).toHaveLength(1);
});

test("a template repin installs the new version at the next start", async () => {
  const x = pluginSetup();
  const ws = x.ws();
  await ws.materialize("lead", "lead", x.tpl, x.input(x.github(x.c1)));
  expect(x.run(await ws.prepare(x.input(x.github(x.c1)))).init.plugins[0].version).toBe("1.0.0");
  const out = await ws.prepare(x.input(x.github(x.c2)));
  expect(out.plugins.expected).toEqual([{ key: "p@mk", pin: `commit:${x.c2}` }]);
  expect(x.run(out).init.plugins[0].version).toBe("2.0.0");
  expect(x.installs()).toHaveLength(2);
});

test("the plugin settings: the closure true, the rest of the catalog and installed strangers false, marketplaces replaced", async () => {
  const x = pluginSetup();
  const ws = x.ws();
  const prep = x.input(x.github(x.c1));
  await ws.materialize("lead", "lead", x.tpl, prep);
  const out = await ws.prepare(prep);
  const settings = JSON.parse(out.plugins.settingsJson);
  expect(settings).toEqual({
    enabledPlugins: {
      "p@mk": true,
      "other@mk": false,
      "dep@mk": false,
      // The skills the agent is linked: switched off as skills-directory plugins too.
      "grilling@skills-dir": false,
      "local@skills-dir": false,
    },
    extraKnownMarketplaces: {
      mk: { source: { source: "github", repo: "o/r", ref: x.c1 }, autoUpdate: false },
    },
    syncClaudeAiPlugins: false,
  });
  // A copy for diagnosis; the workdir's settings carry none of it.
  expect(readFileSync(path.join(x.home, "state/agents/lead/plugin-settings.json"), "utf8")).toBe(
    out.plugins.settingsJson,
  );
  // A plugin the agent installed itself is switched off at the next start (G1 item 10).
  const installed = path.join(x.home, "state/agents/lead/plugins/installed_plugins.json");
  writeFileSync(
    installed,
    JSON.stringify({ version: 2, plugins: { "mine@elsewhere": [{ installPath: "/nowhere" }] } }),
  );
  const again = JSON.parse((await ws.prepare(prep)).plugins.settingsJson);
  expect(again.enabledPlugins["mine@elsewhere"]).toBe(false);
});

test("a plugin's readable dependencies join the closure, and an installed copy's dependency counts only for a declared marketplace", async () => {
  const x = pluginSetup();
  const ws = x.ws("directory");
  const prep = x.input(x.directory, ["p@mk"], "live");
  await ws.materialize("lead", "lead", x.tpl, prep);
  const dir = path.join(x.home, "state/agents/lead/plugins");
  // The agent's installed copy of p now names dep (declared marketplace) and evil (not declared).
  const copy = path.join(dir, "cache/mk/p/1.0.0");
  writeMarketplace(path.join(dir, "cache-src"), "1.0.0", ["dep", "evil@nowhere"]);
  cpSync(path.join(dir, "cache-src/plugins/p"), copy, { recursive: true });
  writeFileSync(
    path.join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "p@mk": [{ scope: "user", installPath: copy }] } }),
  );
  const settings = JSON.parse((await ws.prepare(prep)).plugins.settingsJson);
  expect(settings.enabledPlugins["dep@mk"]).toBe(true);
  expect(settings.enabledPlugins).not.toHaveProperty("evil@nowhere", true);
});

test("the plugin switches follow the declarations: Latest forces auto-update, a remote marketplace syncs the install", async () => {
  const x = pluginSetup();
  const ws = x.ws();
  await ws.materialize("lead", "lead", x.tpl, x.input(x.github(x.c1)));
  const pinned = await ws.prepare(x.input(x.github(x.c1)));
  expect(pinned.plugins).toMatchObject({ latest: false, remote: true });
  const pinnedRun = x.run(pinned);
  expect(pinnedRun.env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(pinned.plugins.dir);
  expect(pinnedRun.env.DISABLE_AUTOUPDATER).toBe("1");
  expect(pinnedRun.env).not.toHaveProperty("FORCE_AUTOUPDATE_PLUGINS");
  expect(pinnedRun.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBe("1");

  const latest = await ws.prepare(x.input(x.github(), ["p@mk"], "latest"));
  expect(JSON.parse(latest.plugins.settingsJson).extraKnownMarketplaces.mk).toEqual({
    source: { source: "github", repo: "o/r" },
    autoUpdate: true,
  });
  expect(latest.plugins).toMatchObject({ latest: true, remote: true });
  expect(x.run(latest).env.FORCE_AUTOUPDATE_PLUGINS).toBe("1");

  // A live directory marketplace: no sync, no forced auto-update, its folder mounts read-only.
  const dirWs = x.ws("directory");
  const live = await dirWs.prepare(x.input(x.directory, ["p@mk"], "live"));
  expect(live.plugins).toMatchObject({ latest: false, remote: false, marketplaceDirs: [x.local] });
  expect(x.run(live).env).not.toHaveProperty("CLAUDE_CODE_SYNC_PLUGIN_INSTALL");
});

test("no plugin is declared: Claude still gets its plugins dir and no self-update, and the dir stays empty", async () => {
  const { ws, tpl, prep, home } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const out = await ws.prepare(prep);
  expect(out.plugins).toMatchObject({ latest: false, remote: false, expected: [] });
  expect(JSON.parse(out.plugins.settingsJson)).toEqual({
    enabledPlugins: { "grilling@skills-dir": false, "local@skills-dir": false },
    extraKnownMarketplaces: {},
    syncClaudeAiPlugins: false,
  });
  expect(readdirSync(path.join(realpathSync(home), "state/agents/lead/plugins"))).toEqual([]);
});

test("a local start below the Claude Code floor fails, naming both versions", async () => {
  const x = pluginSetup({ fakeEnv: { FAKE_CLAUDE_VERSION: "2.1.1" } });
  const ws = x.ws();
  await ws.materialize("lead", "lead", x.tpl, x.input(x.github(x.c1)));
  await expect(ws.prepare(x.input(x.github(x.c1)))).rejects.toThrow(
    "Claude Code 2.1.1 is too old; update it to 2.1.331 or later.",
  );
});

test("a claude that prints no version fails the local start closed", async () => {
  const x = pluginSetup();
  const silent = path.join(mkdtempSync(path.join(tmpdir(), "silent-")), "claude");
  writeFileSync(silent, "#!/bin/sh\nexit 0\n");
  chmodSync(silent, 0o755);
  const ws = new Workspace({
    factoryHome: x.home,
    library: hostOnlyLibrary(x.claude, x.home),
    claudeBin: silent,
    cliBundle: "/nonexistent/open-factory.js",
    lock: new KeyedMutex(),
  });
  await ws.materialize("lead", "lead", x.tpl, x.prep);
  await expect(ws.prepare(x.prep)).rejects.toThrow(/printed no readable version/);
});

test("a declared marketplace whose catalog Skills can't read fails the start instead of leaving its plugins on", async () => {
  const x = pluginSetup();
  const ws = x.ws();
  // A commit the Library never checked out: no catalog to switch the other plugins off from.
  const unread = "b".repeat(40);
  await ws.materialize("lead", "lead", x.tpl, x.input(x.github(unread)));
  await expect(ws.prepare(x.input(x.github(unread)))).rejects.toThrow(
    /Skills can't read mk at bbbbbbbbbbbb\. Fetch it in Skills\./,
  );
});

test("the floor check runs once per binary: a second start doesn't ask claude again, and a failure is asked again", async () => {
  const x = pluginSetup();
  const dir = mkdtempSync(path.join(tmpdir(), "counting-"));
  const count = path.join(dir, "runs");
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\necho '2.1.331 (Claude Code)'\n`);
  chmodSync(bin, 0o755);
  const ws = new Workspace({
    factoryHome: x.home,
    library: hostOnlyLibrary(x.claude, x.home),
    claudeBin: bin,
    cliBundle: "/nonexistent/open-factory.js",
    lock: new KeyedMutex(),
  });
  await ws.materialize("lead", "lead", x.tpl, x.prep);
  await ws.prepare(x.prep);
  await ws.prepare(x.prep);
  expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
});

test("deleteWorkspace runs beforeRemove after the pin check and before anything is removed", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const order: string[] = [];
  let existedBefore: boolean | undefined;
  const deleted = await ws.deleteWorkspace(
    "lead",
    async () => {
      order.push("pin check");
      return true;
    },
    async () => void order.push("marked deleted"),
    async () => {
      order.push("before remove");
      existedBefore = existsSync(ws.workdir("lead"));
    },
  );
  expect(deleted).toBe(true);
  expect(order).toEqual(["pin check", "before remove", "marked deleted"]);
  expect(existedBefore).toBe(true);
  expect(existsSync(ws.workdir("lead"))).toBe(false);
});

test("a pinned workspace is neither cleaned up nor removed", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  let ran = false;
  const deleted = await ws.deleteWorkspace(
    "lead",
    async () => false,
    async () => {},
    async () => {
      ran = true;
    },
  );
  expect(deleted).toBe(false);
  expect(ran).toBe(false);
  expect(existsSync(ws.workdir("lead"))).toBe(true);
});
