import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { AgentStartError } from "../agents/errors.ts";
import { KeyedMutex } from "./lock.ts";
import { pluginsConfigDir } from "./paths.ts";
import {
  capOutput,
  installPlugins,
  marketplaceSourceArg,
  PluginInstallError,
  redactOutput,
} from "./plugins.ts";
import { WorkspaceError } from "./safe-fs.ts";
import { Workspace } from "./workspace.ts";

const hostEnv = { hostHome: process.env.HOME, path: process.env.PATH };
const tplSettings = {
  extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/x/mk" } } },
};
test("adds marketplaces then installs, with a minimal env", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await installPlugins({
    claudeBin: fake.bin,
    pluginsConfig: cfg,
    plugins: ["p@mk"],
    tplSettings,
    hostHome: "/h",
    path: process.env.PATH,
  });
  const s = JSON.parse(readFileSync(path.join(cfg, "settings.json"), "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  const log = readFileSync(path.join(fake.dir, "plugin.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(log.map((l) => l.argv.slice(0, 3))).toEqual([
    ["plugin", "marketplace", "add"],
    ["plugin", "install", "p@mk"],
  ]);
  for (const l of log) {
    // Exactly PATH, HOME and CLAUDE_CONFIG_DIR; the rest is what the fake's sh wrapper and macOS add.
    const added = ["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"];
    const own = l.env.filter((k: string) => !k.startsWith("FAKE_CLAUDE_") && !added.includes(k));
    expect(own).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
    expect(l.configDir).toBe(cfg);
    expect(l.cwd).not.toBe(cfg);
    expect(existsSync(l.cwd)).toBe(false);
  }
});
test("failure carries redacted output; budget enforced", async () => {
  const fake = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_PLUGIN_FAIL: "p@mk" } });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await expect(
    installPlugins({
      claudeBin: fake.bin,
      pluginsConfig: cfg,
      plugins: ["p@mk"],
      tplSettings,
      ...hostEnv,
    }),
  ).rejects.toBeInstanceOf(PluginInstallError);
  const slow = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_SLEEP_MS: "2000" },
  });
  await expect(
    installPlugins({
      claudeBin: slow.bin,
      pluginsConfig: cfg,
      plugins: ["p@mk"],
      tplSettings,
      ...hostEnv,
      budgetMs: 300,
    }),
  ).rejects.toThrow("Plugin install took longer than 4 minutes.");
});
test("source args and redaction", () => {
  expect(marketplaceSourceArg({ source: { source: "git", url: "https://h/r.git" } })).toBe(
    "https://h/r.git",
  );
  expect(marketplaceSourceArg({ source: { source: "github", repo: "o/r" } })).toBe("o/r");
  expect(redactOutput("clone https://user:pw@host/x sk-ant-oat01-abc")).toBe(
    "clone https://[redacted]@host/x [redacted]",
  );
});

test("redaction covers tokens, bearer, query secrets and userinfo with @", () => {
  expect(redactOutput("https://u:p@ss@h/x")).toBe("https://[redacted]@h/x");
  expect(redactOutput("ssh://git:pw@h/x")).toBe("ssh://[redacted]@h/x");
  const out = redactOutput(
    "ghp_abcDEF123 github_pat_11AA_bb glpat-xyz_1-2 Authorization: Bearer abc.def?x=1 u?access_token=zzz&password=hunter2&token=t1",
  );
  for (const secret of [
    "ghp_abcDEF123",
    "github_pat_11AA_bb",
    "glpat-xyz_1-2",
    "abc.def",
    "zzz",
    "hunter2",
    "t1",
  ])
    expect(out).not.toContain(secret);
});
test("failure message and output are redacted; timeouts say so; dash-leading args refused", async () => {
  const fake = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_FAIL: "https://u:p@ss@h/x?token=abc@mk" },
  });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  const e = await installPlugins({
    claudeBin: fake.bin,
    pluginsConfig: cfg,
    plugins: ["https://u:p@ss@h/x?token=abc@mk"],
    tplSettings,
    ...hostEnv,
  }).catch((x) => x);
  expect(e).toBeInstanceOf(PluginInstallError);
  expect(e.message + e.output).not.toMatch(/p@ss|abc/);
  expect(e.output).toContain("[redacted]");
  const slow = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_SLEEP_MS: "3000" },
  });
  await expect(
    installPlugins({
      claudeBin: slow.bin,
      pluginsConfig: cfg,
      plugins: ["p@mk"],
      tplSettings,
      ...hostEnv,
      commandTimeoutMs: 300,
    }),
  ).rejects.toThrow(/timed out after 0\.3 s/);
  await expect(
    installPlugins({
      claudeBin: fake.bin,
      pluginsConfig: cfg,
      plugins: ["--evil@mk"],
      tplSettings,
      ...hostEnv,
    }),
  ).rejects.toBeInstanceOf(PluginInstallError);
});

// Spec §11.7: plugins live in the factory-owned plugins-config/, linked into the agent's config dir.
async function setupAgent(plugins: string[], fakeEnv: Record<string, string> = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "of-plug-")));
  const hs = mkdtempSync(path.join(tmpdir(), "hs-"));
  const tdir = path.join(home, "templates/lead");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, "AGENTS.md"), "# Lead\n");
  const config = templateYamlSchema.parse({
    name: "lead",
    display_name: "Lead",
    runtime: "local",
    plugins,
  });
  const fake = createFakeClaude({ scenario: "reply", env: fakeEnv });
  const ws = new Workspace({
    factoryHome: home,
    hostSkillsDir: hs,
    claudeBin: fake.bin,
    cliBundle: "/nonexistent/open-factory.js",
    lock: new KeyedMutex(),
  });
  const tpl = { dir: tdir, config, tplSettings, tplMcp: { mcpServers: {} } };
  const prep = {
    slug: "lead",
    displayName: "Lead",
    description: "d",
    template: "lead",
    config,
    effective: {
      doc: { template: {}, settings: tplSettings, mcp: tpl.tplMcp },
      config,
      templatePlugins: [],
    },
    manager: null,
    grants: [],
    peers: [],
    reports: [],
    humans: [],
    mcpUrl: "http://127.0.0.1:3001/mcp",
    kind: "persistent" as const,
    spawner: null,
    spawning: null,
    secretNames: config.secrets,
  };
  await ws.materialize("lead", "lead", tpl, prep);
  const workdir = ws.workdir("lead");
  const pluginRuns = () => {
    const f = path.join(fake.dir, "plugin.log");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").length : 0;
  };
  const pluginLog = (): { argv: string[]; env: string[]; cwd: string }[] => {
    const f = path.join(fake.dir, "plugin.log");
    return existsSync(f)
      ? readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  };
  /** The agent as it is after a template or overlay adds plugins: the effective list, and who lists them. */
  const withPlugins = (list: string[], fromTemplate: string[]) => ({
    ...prep,
    effective: {
      ...prep.effective,
      config: { ...prep.effective.config, plugins: list },
      templatePlugins: fromTemplate,
    },
  });
  return { home, ws, tpl, prep, workdir, pluginRuns, pluginLog, withPlugins };
}

test("materialize installs into plugins-config; prepare links .claude-config/plugins to plugins-config/plugins", async () => {
  const { home, ws, prep, workdir } = await setupAgent(["p@mk"]);
  expect(existsSync(`${pluginsConfigDir(home, "lead")}/plugins`)).toBe(true);
  expect(existsSync(`${workdir}/.claude-config/settings.json`)).toBe(false);
  await ws.prepare(prep);
  expect(await readlink(`${workdir}/.claude-config/plugins`)).toBe(
    `${pluginsConfigDir(home, "lead")}/plugins`,
  );
  const s = JSON.parse(readFileSync(`${workdir}/.claude-config/settings.json`, "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  expect(s.extraKnownMarketplaces).toHaveProperty("mk");
});

test("start installs only the listed plugins that are missing, through the hardened env and an empty cwd", async () => {
  const { ws, prep, workdir, pluginLog, withPlugins } = await setupAgent(["a@mk"]);
  const before = pluginLog().length;
  await ws.prepare(withPlugins(["a@mk", "b@mk"], ["a@mk", "b@mk"]));
  const runs = pluginLog().slice(before);
  expect(runs.map((r) => r.argv.slice(1, 3))).toEqual([
    ["marketplace", "add"],
    ["install", "b@mk"],
  ]);
  for (const r of runs) {
    const added = ["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"];
    const own = r.env.filter((k) => !k.startsWith("FAKE_CLAUDE_") && !added.includes(k));
    expect(own).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
    expect(r.cwd.startsWith(workdir)).toBe(false);
  }
  const s = JSON.parse(readFileSync(`${workdir}/.claude-config/settings.json`, "utf8"));
  expect(s.enabledPlugins).toEqual({ "a@mk": true, "b@mk": true });
  // Nothing is missing now: the next start installs nothing.
  const after = pluginLog().length;
  await ws.prepare(withPlugins(["a@mk", "b@mk"], ["a@mk", "b@mk"]));
  expect(pluginLog().length).toBe(after);
  await ws.prepare(prep); // dropping a plugin from the list uninstalls nothing and installs nothing
  expect(pluginLog().length).toBe(after);
});

test("a start installs a plugin whose plugins-config is gone", async () => {
  const { home, ws, prep, pluginRuns } = await setupAgent(["p@mk"]);
  await rm(pluginsConfigDir(home, "lead"), { recursive: true, force: true });
  const before = pluginRuns();
  await ws.prepare(prep);
  expect(pluginRuns()).toBeGreaterThan(before);
  expect(
    JSON.parse(readFileSync(`${pluginsConfigDir(home, "lead")}/settings.json`, "utf8"))
      .enabledPlugins,
  ).toEqual({ "p@mk": true });
});

test("marketplace sources come from the effective settings, never from the workdir", async () => {
  const { ws, workdir, pluginLog, withPlugins } = await setupAgent(["a@mk"]);
  mkdirSync(`${workdir}/.claude`, { recursive: true });
  writeFileSync(
    `${workdir}/.claude/settings.json`,
    JSON.stringify({
      extraKnownMarketplaces: { mk2: { source: { source: "directory", path: "/evil" } } },
    }),
  );
  const p = withPlugins(["a@mk", "b@mk2"], []);
  await expect(ws.prepare(p)).rejects.toMatchObject({
    message: "Plugin b@mk2 didn't install.",
    fix: "config",
  });
  expect(pluginLog().flatMap((r) => r.argv)).not.toContain("/evil");
});

test("a failed install fails the start closed; the fix names who lists the plugin", async () => {
  const { ws, withPlugins } = await setupAgent(["a@mk"], { FAKE_CLAUDE_PLUGIN_FAIL: "b@mk" });
  const fromTemplate = await ws.prepare(withPlugins(["a@mk", "b@mk"], ["b@mk"])).catch((e) => e);
  expect(fromTemplate).toBeInstanceOf(AgentStartError);
  expect(fromTemplate).toMatchObject({ message: "Plugin b@mk didn't install.", fix: "template" });
  const fromOverlay = await ws.prepare(withPlugins(["a@mk", "b@mk"], ["a@mk"])).catch((e) => e);
  expect(fromOverlay).toMatchObject({ message: "Plugin b@mk didn't install.", fix: "config" });
  expect(fromOverlay.detail).toContain("Failed to install plugin");
});

// Secret-shaped values only: redaction recognises shapes, not arbitrary env values.
const ECHO =
  "ANTHROPIC_API_KEY=sk-ant-api03-SECRETVALUE0123 GITHUB_TOKEN=ghp_SECRETTOKEN0123 " +
  "cloning https://user:tok-SECRET@host.example/org/mk.git Authorization: Bearer abc.SECRET.def " +
  "retry with token=hunter2SECRET";
const SECRETS = [
  "sk-ant-api03-SECRETVALUE0123",
  "ghp_SECRETTOKEN0123",
  "tok-SECRET",
  "abc.SECRET.def",
  "hunter2SECRET",
];

test("a failed install's output reaches the error through redactOutput", async () => {
  const { ws, withPlugins } = await setupAgent(["a@mk"], {
    FAKE_CLAUDE_PLUGIN_FAIL: "b@mk",
    FAKE_CLAUDE_PLUGIN_ECHO: ECHO,
  });
  const err = await ws.prepare(withPlugins(["a@mk", "b@mk"], ["b@mk"])).catch((e) => e);
  expect(err).toBeInstanceOf(AgentStartError);
  const text = `${err.message}\n${err.detail}`;
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(err.detail).toContain("[redacted]@host.example");
  expect(err.detail).toContain("Failed to install plugin");
});

test("a failure with no output still says why, redacted", async () => {
  const { ws, prep } = await setupAgent([], { FAKE_CLAUDE_PLUGIN_SILENT_FAIL: "marketplace" });
  const url = "https://user:tok-SECRET@host.example/org/mk.git";
  const err = await ws
    .prepare({
      ...prep,
      effective: {
        ...prep.effective,
        doc: {
          ...prep.effective.doc,
          settings: { extraKnownMarketplaces: { mk2: { source: { source: "git", url } } } },
        },
        config: { ...prep.effective.config, plugins: ["b@mk2"] },
        templatePlugins: [],
      },
    })
    .catch((e) => e);
  expect(err).toMatchObject({ message: "Plugin b@mk2 didn't install.", fix: "config" });
  // The command line (with the marketplace URL) is the only clue; its credentials are redacted.
  expect(err.detail).toContain("marketplace add https://[redacted]@host.example/org/mk.git");
  expect(err.detail).not.toContain("tok-SECRET");
});

test("a failed install's output is the last 20 lines, at most 4 KB", async () => {
  const noisy = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(400)}`).join("\n");
  const { ws, withPlugins } = await setupAgent(["a@mk"], {
    FAKE_CLAUDE_PLUGIN_FAIL: "b@mk",
    FAKE_CLAUDE_PLUGIN_ECHO: noisy,
  });
  const err = await ws.prepare(withPlugins(["a@mk", "b@mk"], ["b@mk"])).catch((e) => e);
  expect(Buffer.byteLength(err.detail)).toBeLessThanOrEqual(4096);
  expect(err.detail).toContain("line 59 ");
  expect(err.detail).not.toContain("line 10 ");
  const few = Array.from({ length: 30 }, (_, i) => `short ${i}`).join("\n");
  expect(capOutput(few).split("\n")).toHaveLength(20);
  expect(capOutput(few)).toContain("short 29");
  expect(capOutput(few)).not.toContain("short 9\n");
});

test("a real plugins folder is refused, never moved aside", async () => {
  const { ws, prep, workdir } = await setupAgent([]);
  mkdirSync(`${workdir}/.claude-config/plugins/store`, { recursive: true });
  writeFileSync(`${workdir}/.claude-config/plugins/store/builtin.json`, "{}");
  const err = await ws.prepare(prep).catch((e) => e);
  expect(err).toBeInstanceOf(WorkspaceError);
  expect(err.message).toBe(`${workdir}/.claude-config/plugins isn't a link; move it away.`);
  expect(existsSync(`${workdir}/.claude-config/plugins/store/builtin.json`)).toBe(true);
});

test("an agent without plugins gets its plugins link at start", async () => {
  const fresh = await setupAgent([]);
  await fresh.ws.prepare(fresh.prep);
  expect(lstatSync(`${fresh.workdir}/.claude-config/plugins`).isSymbolicLink()).toBe(true);
  expect(fresh.pluginRuns()).toBe(0);
});
