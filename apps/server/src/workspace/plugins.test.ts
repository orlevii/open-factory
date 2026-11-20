import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { KeyedMutex } from "./lock.ts";
import { pluginsConfigDir } from "./paths.ts";
import {
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
async function setupAgent(plugins: string[]) {
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
  const fake = createFakeClaude({ scenario: "reply" });
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
    manager: null,
    grants: [],
    peers: [],
    reports: [],
    mcpUrl: "http://127.0.0.1:3001/mcp",
  };
  await ws.materialize("lead", "lead", tpl, prep);
  const workdir = ws.workdir("lead");
  const pluginRuns = () => {
    const f = path.join(fake.dir, "plugin.log");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").length : 0;
  };
  /** Turns the agent back into an S4 one: plugins installed in a real config-dir folder. */
  const makeS4 = async () => {
    await rm(pluginsConfigDir(home, "lead"), { recursive: true, force: true });
    await rm(`${workdir}/.claude-config/plugins`, { recursive: true, force: true });
    mkdirSync(`${workdir}/.claude-config/plugins/cache`, { recursive: true });
    writeFileSync(`${workdir}/.claude-config/plugins/installed_plugins.json`, "{}");
  };
  return { home, ws, tpl, prep, workdir, pluginRuns, makeS4 };
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

test("an S4 agent with plugins and no plugins-config fails to start with the re-sync fix, and nothing is installed", async () => {
  const { home, ws, prep, workdir, pluginRuns, makeS4 } = await setupAgent(["p@mk"]);
  await makeS4();
  const before = pluginRuns();
  const err = await ws.prepare(prep).catch((e) => e);
  expect(err).toBeInstanceOf(WorkspaceError);
  expect(err.message).toBe(
    "Re-sync @lead to reinstall its plugins into the factory-managed location.",
  );
  expect(err.fix).toBe("resync");
  expect(pluginRuns()).toBe(before);
  expect(existsSync(pluginsConfigDir(home, "lead"))).toBe(false);
  expect(lstatSync(`${workdir}/.claude-config/plugins`).isDirectory()).toBe(true);
});

test("a plugin listed in the snapshot but missing from plugins-config also asks for a re-sync", async () => {
  const { ws, prep } = await setupAgent(["p@mk"]);
  const config = { ...prep.config, plugins: ["p@mk", "q@mk"] };
  await expect(ws.prepare({ ...prep, config })).rejects.toMatchObject({ fix: "resync" });
});

test("re-sync installs into plugins-config, moves the old real plugins dir to plugins-legacy-<ts>/ and links it", async () => {
  const { home, ws, tpl, prep, workdir, makeS4 } = await setupAgent(["p@mk"]);
  await makeS4();
  await ws.resync("lead", tpl, { canWriteNow: true });
  const cfg = pluginsConfigDir(home, "lead");
  expect(JSON.parse(readFileSync(`${cfg}/settings.json`, "utf8")).enabledPlugins).toEqual({
    "p@mk": true,
  });
  expect(await readlink(`${workdir}/.claude-config/plugins`)).toBe(`${cfg}/plugins`);
  const state = path.dirname(cfg);
  const legacy = readdirSync(state).filter((d) => d.startsWith("plugins-legacy-"));
  expect(legacy).toHaveLength(1);
  expect(legacy[0]).toMatch(/^plugins-legacy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  expect(existsSync(path.join(state, legacy[0] as string, "installed_plugins.json"))).toBe(true);
  await ws.prepare(prep); // the start now succeeds
});

test("an S4 agent without plugins migrates silently at prepare", async () => {
  const { home, ws, prep, workdir, pluginRuns } = await setupAgent([]);
  await rm(pluginsConfigDir(home, "lead"), { recursive: true, force: true });
  // Claude writes plugins/store/ into a writable plugins dir at start, so an S4 dir may not be empty.
  mkdirSync(`${workdir}/.claude-config/plugins/store`, { recursive: true });
  writeFileSync(`${workdir}/.claude-config/plugins/store/builtin.json`, "{}");
  await ws.prepare(prep);
  expect(await readlink(`${workdir}/.claude-config/plugins`)).toBe(
    `${pluginsConfigDir(home, "lead")}/plugins`,
  );
  expect(existsSync(`${pluginsConfigDir(home, "lead")}/plugins`)).toBe(true);
  expect(pluginRuns()).toBe(0);
  const fresh = await setupAgent([]);
  await fresh.ws.prepare(fresh.prep); // missing dir: the link is created too
  expect(lstatSync(`${fresh.workdir}/.claude-config/plugins`).isSymbolicLink()).toBe(true);
});
