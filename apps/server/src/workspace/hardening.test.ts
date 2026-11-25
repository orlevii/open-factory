// Spec §11.4: each escape an agent can plant in its writable workdir fails closed.
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
import { rm, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude, type FakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { beforeEach, expect, test } from "vitest";
import { hostOnlyLibrary, writeHostSkill } from "../test/library.ts";
import { KeyedMutex } from "./lock.ts";
import { MountRefusedError } from "./mounts.ts";
import { UnsafePathError } from "./safe-fs.ts";
import { Workspace } from "./workspace.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

let home: string;
let hostDir: string;
let secretFile: string;
let workdir: string;
let ws: Workspace;
let tpl: Parameters<Workspace["materialize"]>[2];
let prep: Parameters<Workspace["prepare"]>[0];
let fake: FakeClaude;

beforeEach(async () => {
  home = tmp("of-hard-");
  hostDir = tmp("host-");
  secretFile = path.join(tmp("secret-"), "id_ed25519");
  writeFileSync(secretFile, "PRIVATE KEY");
  const claude = tmp("claude-");
  const hs = path.join(claude, "skills");
  writeHostSkill(claude, "grilling");
  const repo = tmp("repo-");
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
  fake = createFakeClaude({ scenario: "reply" });
  const cliBundle = path.join(tmp("cli-"), "open-factory.js");
  writeFileSync(cliBundle, "//");
  ws = new Workspace({
    factoryHome: home,
    library: hostOnlyLibrary(claude, home),
    claudeBin: fake.bin,
    cliBundle,
    lock: new KeyedMutex(),
  });
  tpl = { dir: tdir, config, tplSettings: {}, tplMcp: { mcpServers: {} } };
  prep = {
    slug: "lead",
    displayName: "Lead",
    description: "d",
    template: "lead",
    effective: {
      doc: { template: {}, settings: {}, mcp: { mcpServers: {} } },
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
  await ws.materialize("lead", "lead", tpl, { ...prep, config });
  workdir = ws.workdir("lead");
});

const prepareAgent = () => ws.prepare(prep);

test("prepare fails closed when .claude-config is a symlink to a host dir", async () => {
  await rm(`${workdir}/.claude-config`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/.claude-config`);
  await expect(prepareAgent()).rejects.toBeInstanceOf(UnsafePathError);
  await expect(prepareAgent()).rejects.toThrow(
    `${workdir}/.claude-config is a symlink; the factory won't write through it.`,
  );
  expect(readdirSync(hostDir)).toEqual([]);
});

test("projects/ as a symlink to a directory fails the start", async () => {
  await rm(`${workdir}/projects`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/projects`);
  await expect(prepareAgent()).rejects.toThrow(/is a symlink/);
  expect(readdirSync(hostDir)).toEqual([]);
});

test(".claude as a symlink fails the start, writing nothing through it", async () => {
  await rm(`${workdir}/.claude`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/.claude`);
  await expect(prepareAgent()).rejects.toThrow(/is a symlink/);
  expect(readdirSync(hostDir)).toEqual([]);
});

test("a settings.json symlink to a host file is neither read nor written through", async () => {
  const hostJson = path.join(hostDir, "settings.json");
  const hostContent = JSON.stringify({
    extraKnownMarketplaces: { leak: { source: { source: "directory", path: "/leak" } } },
  });
  writeFileSync(hostJson, hostContent);
  await rm(`${workdir}/.claude-config/settings.json`, { force: true });
  await symlink(hostJson, `${workdir}/.claude-config/settings.json`);
  await prepareAgent();
  const written = readFileSync(`${workdir}/.claude-config/settings.json`, "utf8");
  expect(lstatSync(`${workdir}/.claude-config/settings.json`).isFile()).toBe(true);
  expect(written).not.toContain("/leak");
  expect(readFileSync(hostJson, "utf8")).toBe(hostContent);
});

test(".mcp.json and CLAUDE.md symlinks are replaced, never followed", async () => {
  const a = path.join(hostDir, "a");
  const b = path.join(hostDir, "b");
  writeFileSync(a, "host a");
  writeFileSync(b, "host b");
  await symlink(a, `${workdir}/.mcp.json`);
  await symlink(b, `${workdir}/.claude-config/CLAUDE.md`);
  await prepareAgent();
  expect(readFileSync(a, "utf8")).toBe("host a");
  expect(readFileSync(b, "utf8")).toBe("host b");
  expect(lstatSync(`${workdir}/.mcp.json`).isFile()).toBe(true);
});

test("create's rollback never follows a link inside the workdir", async () => {
  writeFileSync(path.join(hostDir, "keep"), "x");
  await symlink(hostDir, `${workdir}/escape`);
  await ws.discard("lead");
  expect(existsSync(workdir)).toBe(false);
  expect(readdirSync(hostDir)).toEqual(["keep"]);
});

test("plugin keys planted in the agent's own settings never reach the settings the factory writes", async () => {
  await writeFile(
    `${workdir}/.claude-config/settings.json`,
    JSON.stringify({
      enabledPlugins: { "evil@m": true },
      extraKnownMarketplaces: { evil: { source: { source: "directory", path: "/evil" } } },
    }),
  );
  await prepareAgent();
  const s = JSON.parse(readFileSync(`${workdir}/.claude-config/settings.json`, "utf8"));
  expect(s).not.toHaveProperty("enabledPlugins");
  expect(s).not.toHaveProperty("extraKnownMarketplaces");
});

test("an agent-planted plugin in its plugins dir is switched off, and a link planted there is never read through", async () => {
  const dir = path.join(home, "state/agents/lead/plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(hostDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "evil@m": [{ installPath: hostDir }] } }),
  );
  await symlink(
    path.join(hostDir, "installed_plugins.json"),
    path.join(dir, "installed_plugins.json"),
  );
  const linked = await prepareAgent();
  expect(JSON.parse(linked.plugins.settingsJson).enabledPlugins).not.toHaveProperty("evil@m");
  await rm(path.join(dir, "installed_plugins.json"));
  writeFileSync(
    path.join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "evil@m": [{ installPath: hostDir }] } }),
  );
  const own = await prepareAgent();
  expect(JSON.parse(own.plugins.settingsJson).enabledPlugins["evil@m"]).toBe(false);
});

// Spec §11.4 part 2: mounts come from factory-owned inputs only.
const asDocker = () => {
  prep = {
    ...prep,
    effective: { ...prep.effective, config: { ...prep.effective.config, runtime: "docker" } },
  };
};

test("a marketplace path planted in the agent's config-dir settings never becomes a mount", async () => {
  await writeFile(
    `${workdir}/.claude-config/settings.json`,
    JSON.stringify({
      extraKnownMarketplaces: { x: { source: { source: "directory", path: os.homedir() } } },
    }),
  );
  const { mounts } = await prepareAgent();
  expect(mounts.map((m) => m.source)).not.toContain(os.homedir());
  asDocker();
  await expect(prepareAgent()).resolves.toMatchObject({ workdir });
});

test("a marketplace path planted in the old .factory/template copy never becomes a mount", async () => {
  mkdirSync(`${workdir}/.factory/template`, { recursive: true });
  writeFileSync(
    `${workdir}/.factory/template/settings.json`,
    JSON.stringify({
      extraKnownMarketplaces: { x: { source: { source: "directory", path: os.homedir() } } },
    }),
  );
  const { mounts } = await prepareAgent();
  expect(mounts.map((m) => m.source)).not.toContain(os.homedir());
});

test("a Docker start's mounts pass checkMounts: the agent's plugins dir writable, the CLI bundle read-only", async () => {
  asDocker();
  const { mounts } = await prepareAgent();
  const plugins = path.join(home, "state/agents/lead/plugins");
  expect(mounts).toContainEqual({ source: plugins, target: plugins, readOnly: false });
  expect(mounts.find((m) => m.target === "/opt/factory/bin/open-factory")).toMatchObject({
    readOnly: true,
  });
});

test("a granted project inside FACTORY_HOME fails the Docker start", async () => {
  const other = path.join(home, "agents/other");
  mkdirSync(other, { recursive: true });
  prep = { ...prep, grants: [{ name: "app", hostPath: other }] };
  await expect(prepareAgent()).resolves.toBeDefined(); // local ignores mounts
  asDocker();
  await expect(prepareAgent()).rejects.toBeInstanceOf(MountRefusedError);
  await expect(prepareAgent()).rejects.toThrow(
    `Mount ${other} isn't allowed: it is inside FACTORY_HOME and isn't this agent's workdir, a registered skill or this agent's plugins dir.`,
  );
});

test("a Docker prepare returns the realpath of a symlinked granted project", async () => {
  const real = prep.grants[0]?.hostPath as string;
  const link = path.join(tmp("plink-"), "app");
  await symlink(real, link);
  prep = { ...prep, grants: [{ name: "app", hostPath: link }] };
  asDocker();
  const { mounts, mountCheck } = await prepareAgent();
  expect(mounts).toContainEqual({ source: real, target: real, readOnly: false });
  expect(mounts.map((m) => m.source)).not.toContain(link);
  expect(mountCheck?.grantedPaths).toEqual([link]);
});

test("a granted project that contains FACTORY_HOME fails the Docker start", async () => {
  const parent = path.dirname(home);
  prep = { ...prep, grants: [{ name: "app", hostPath: parent }] };
  asDocker();
  await expect(prepareAgent()).rejects.toThrow(
    `Mount ${parent} isn't allowed: it contains FACTORY_HOME.`,
  );
});

test("a Docker start mounts each template skill read-only at its real path, and refuses a swapped-in link", async () => {
  asDocker();
  const real = realpathSync(path.join(home, "templates/lead/skills/local"));
  const { mounts } = await prepareAgent();
  expect(mounts).toContainEqual({ source: real, target: real, readOnly: true });
  await rm(real, { recursive: true });
  await symlink(hostDir, real);
  await expect(prepareAgent()).rejects.toThrow("skills/local must be a folder, not a link.");
});
