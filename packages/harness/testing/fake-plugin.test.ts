import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeClaude, type FakeScenario } from "./index.js";

// Session-start plugin installs (spec §7.3 steps 4-8, §14): the fake installs what `--settings` declares
// into CLAUDE_CODE_PLUGIN_CACHE_DIR, logs each install, and lists the loaded plugins in `init`.
const INIT_SCENARIO: FakeScenario = {
  onStart: [{ emit: { fixture: "ancestor-agents-md-loads", lines: [1, 1] } }],
  onUser: [],
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();

// A marketplace with one plugin `p` at ./plugins/p, its manifest at `version`.
function writePlugin(root: string, version: string) {
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "mk", plugins: [{ name: "p", source: "./plugins/p" }] }),
  );
  const plugin = path.join(root, "plugins", "p");
  mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "p", version }),
  );
}

function commitVersion(repo: string, version: string): string {
  writePlugin(repo, version);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `v${version}`);
  return git(repo, "rev-parse", "HEAD");
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet", "-b", "main");
}

interface Fixture {
  root: string;
  /** The `file://` root that `FAKE_CLAUDE_GITHUB_URL` points at; `o/r` lives under it. */
  gh: string;
  /** A directory marketplace, version 1.0.0. */
  local: string;
  fake: ReturnType<typeof createFakeClaude>;
  cache: string;
}

function makeFixture(env: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "fake-plugin-"));
  const gh = path.join(root, "gh");
  const local = path.join(root, "local");
  writePlugin(local, "1.0.0");
  const cache = path.join(root, "plugins");
  const fake = createFakeClaude({
    scenario: INIT_SCENARIO,
    dir: path.join(root, "fake"),
    env: {
      CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
      FAKE_CLAUDE_GITHUB_URL: `file://${gh}`,
      ...env,
    },
  });
  return { root, gh, local, fake, cache };
}

// A repo served as the `o/r` GitHub repo (and as `file://` git source at `repo`).
function fixtureRepo(fx: Fixture) {
  const repo = path.join(fx.gh, "o", "r.git");
  initRepo(repo);
  return repo;
}

const gitSource = (repo: string, ref?: string) => ({
  source: { source: "git", url: `file://${repo}`, ...(ref ? { ref } : {}) },
});
const githubSource = (ref?: string) => ({
  source: { source: "github", repo: "o/r", ...(ref ? { ref } : {}) },
});
const dirSource = (dir: string) => ({ source: { source: "directory", path: dir } });

function start(fx: Fixture, settings: object) {
  const r = spawnSync(fx.fake.bin, ["--settings", JSON.stringify(settings)], {
    input: "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 20_000,
  });
  const init = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((o) => o.type === "system" && o.subtype === "init");
  return { ...r, init };
}

const installLog = (fx: Fixture) => {
  const f = path.join(fx.fake.dir, "plugin.log");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
};
const knownFile = (fx: Fixture) =>
  JSON.parse(readFileSync(path.join(fx.cache, "known_marketplaces.json"), "utf8"));
const installedFile = (fx: Fixture) =>
  JSON.parse(readFileSync(path.join(fx.cache, "installed_plugins.json"), "utf8"));

describe("fake claude installs declared plugins at session start", () => {
  it("a cold start installs a directory marketplace's plugin and lists it in init", () => {
    const fx = makeFixture();
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    });
    const installPath = path.join(fx.cache, "cache", "mk", "p", "1.0.0");
    expect(r.init?.plugins).toEqual([
      { name: "p", path: installPath, source: "p@mk", version: "1.0.0" },
    ]);
    expect(existsSync(path.join(installPath, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(installedFile(fx).plugins["p@mk"][0]).toMatchObject({
      scope: "user",
      installPath,
      version: "1.0.0",
    });
    expect(installLog(fx)).toHaveLength(1);
    const entry = installedFile(fx).plugins["p@mk"][0];
    expect(installedFile(fx).version).toBe(2);
    expect(Date.parse(entry.installedAt)).not.toBeNaN();
    expect(Date.parse(entry.lastUpdated)).not.toBeNaN();
    expect(entry).not.toHaveProperty("gitCommitSha");
    expect(knownFile(fx).mk).toMatchObject({
      source: { source: "directory", path: fx.local },
      installLocation: path.join(fx.cache, "marketplaces", "mk"),
      autoUpdate: false,
    });
    expect(Date.parse(knownFile(fx).mk.lastUpdated)).not.toBeNaN();
  });

  it("a git source installs the commit at its ref", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    const c1 = commitVersion(repo, "1.0.0");
    commitVersion(repo, "2.0.0");
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: gitSource(repo, c1) },
    });
    expect(r.init?.plugins?.[0]).toMatchObject({ source: "p@mk", version: "1.0.0" });
    expect(installedFile(fx).plugins["p@mk"][0].gitCommitSha).toBe(c1);
    expect(knownFile(fx).mk).toMatchObject({
      source: { source: "git", url: `file://${repo}`, ref: c1 },
      installLocation: path.join(fx.cache, "marketplaces", "mk"),
    });
    expect(installLog(fx)).toEqual([
      `install p@mk ${c1} ${path.join(fx.cache, "cache", "mk", "p", "1.0.0")}`,
    ]);
  });

  it("a github source installs its commit from FAKE_CLAUDE_GITHUB_URL", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    const c1 = commitVersion(repo, "1.0.0");
    commitVersion(repo, "2.0.0");
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: githubSource(c1) },
    });
    expect(r.init?.plugins?.[0]).toMatchObject({ version: "1.0.0" });
    expect(installedFile(fx).plugins["p@mk"][0].gitCommitSha).toBe(c1);
  });

  it("a tag ref installs the tagged commit", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    commitVersion(repo, "1.0.0");
    git(repo, "tag", "v1");
    commitVersion(repo, "2.0.0");
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: githubSource("v1") },
    });
    expect(r.init?.plugins?.[0]).toMatchObject({ version: "1.0.0" });
  });

  it("no ref takes the marketplace's HEAD", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    commitVersion(repo, "1.0.0");
    const head = commitVersion(repo, "2.0.0");
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: gitSource(repo) },
    });
    expect(r.init?.plugins?.[0]).toMatchObject({ version: "2.0.0" });
    expect(installedFile(fx).plugins["p@mk"][0].gitCommitSha).toBe(head);
  });

  it("a second start at the same commit installs nothing and still lists the plugin", () => {
    const fx = makeFixture();
    const settings = {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    };
    start(fx, settings);
    const again = start(fx, settings);
    expect(installLog(fx)).toHaveLength(1);
    expect(again.init?.plugins).toHaveLength(1);
  });

  it("a repeated start at the same git commit installs nothing", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    const c1 = commitVersion(repo, "1.0.0");
    const settings = {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: gitSource(repo, c1) },
    };
    start(fx, settings);
    const again = start(fx, settings);
    expect(installLog(fx)).toHaveLength(1);
    expect(again.init?.plugins).toHaveLength(1);
  });

  it("a changed ref installs the new version", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    const c1 = commitVersion(repo, "1.0.0");
    const c2 = commitVersion(repo, "2.0.0");
    start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: gitSource(repo, c1) },
    });
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: gitSource(repo, c2) },
    });
    expect(installLog(fx)).toHaveLength(2);
    expect(r.init?.plugins?.[0]).toMatchObject({ version: "2.0.0" });
    expect(installedFile(fx).plugins["p@mk"][0].gitCommitSha).toBe(c2);
  });

  it("a false key is neither installed nor loaded", () => {
    const fx = makeFixture();
    const r = start(fx, {
      enabledPlugins: { "p@mk": false },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    });
    expect(r.init?.plugins).toEqual([]);
    expect(installLog(fx)).toEqual([]);
  });

  it("install-fail installs nothing and still emits init without the plugin", () => {
    const fx = makeFixture({ FAKE_CLAUDE_PLUGIN_SCENARIO: "install-fail" });
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    });
    expect(r.init?.plugins).toEqual([]);
    expect(installLog(fx)).toEqual([]);
    expect(existsSync(path.join(fx.cache, "installed_plugins.json"))).toBe(false);
  });

  it("slow waits FAKE_CLAUDE_PLUGIN_SLEEP_MS before installing", () => {
    const fx = makeFixture({
      FAKE_CLAUDE_PLUGIN_SCENARIO: "slow",
      FAKE_CLAUDE_PLUGIN_SLEEP_MS: "400",
    });
    const t0 = Date.now();
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(r.init?.plugins).toHaveLength(1);
  });

  it("late emits init before the plugins install", () => {
    const fx = makeFixture({ FAKE_CLAUDE_PLUGIN_SCENARIO: "late" });
    const r = start(fx, {
      enabledPlugins: { "p@mk": true },
      extraKnownMarketplaces: { mk: dirSource(fx.local) },
    });
    expect(r.init?.plugins).toEqual([]);
    expect(installLog(fx)).toHaveLength(1);
  });

  it("a commit pin on the reserved official marketplace installs nothing and never clones", () => {
    const fx = makeFixture();
    const repo = fixtureRepo(fx);
    const c1 = commitVersion(repo, "1.0.0");
    const r = start(fx, {
      enabledPlugins: { "p@claude-plugins-official": true },
      extraKnownMarketplaces: {
        "claude-plugins-official": githubSource(c1),
      },
    });
    expect(r.init?.plugins).toEqual([]);
    expect(installLog(fx)).toEqual([]);
    expect(existsSync(path.join(fx.cache, "marketplaces", "claude-plugins-official"))).toBe(false);
  });

  it("--version prints the Claude Code version", () => {
    const fx = makeFixture();
    const r = spawnSync(fx.fake.bin, ["--version"], { encoding: "utf8" });
    expect(r.stdout).toBe("2.1.331 (Claude Code)\n");
    const overridden = makeFixture({ FAKE_CLAUDE_VERSION: "9.9.9" });
    const r2 = spawnSync(overridden.fake.bin, ["--version"], { encoding: "utf8" });
    expect(r2.stdout).toBe("9.9.9 (Claude Code)\n");
  });
});
