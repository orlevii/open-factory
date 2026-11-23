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
import { lstat, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude, type FakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { beforeEach, expect, test } from "vitest";
import { KeyedMutex } from "./lock.ts";
import { MountRefusedError } from "./mounts.ts";
import { pluginsConfigDir, resyncRoot } from "./paths.ts";
import { UnsafePathError } from "./safe-fs.ts";
import { Workspace } from "./workspace.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

let home: string;
let hostDir: string;
let secretFile: string;
let workdir: string;
let ws: Workspace;
let tpl: Parameters<Workspace["resync"]>[1];
let prep: Parameters<Workspace["prepare"]>[0];
let fake: FakeClaude;

beforeEach(async () => {
  home = tmp("of-hard-");
  hostDir = tmp("host-");
  secretFile = path.join(tmp("secret-"), "id_ed25519");
  writeFileSync(secretFile, "PRIVATE KEY");
  const hs = tmp("hs-");
  mkdirSync(path.join(hs, "grilling"));
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
    hostSkillsDir: hs,
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
    effective: { doc: { template: {}, settings: {}, mcp: { mcpServers: {} } }, config },
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
  await ws.materialize("lead", "lead", tpl, { ...prep, config });
  workdir = ws.workdir("lead");
});

const prepareAgent = () => ws.prepare(prep);
const resync = () => ws.resync("lead", tpl, { canWriteNow: true });
async function findBackup(rel: string): Promise<string> {
  const root = resyncRoot(home, "lead");
  const [stamp] = await readdir(root);
  if (!stamp) throw new Error("no backup");
  return path.join(root, stamp, rel);
}

test("prepare fails closed when .claude-config is a symlink to a host dir", async () => {
  await rm(`${workdir}/.claude-config`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/.claude-config`);
  await expect(prepareAgent()).rejects.toBeInstanceOf(UnsafePathError);
  await expect(prepareAgent()).rejects.toThrow(
    `${workdir}/.claude-config is a symlink; the factory won't write through it.`,
  );
  expect(readdirSync(hostDir)).toEqual([]);
});

test("re-sync backup of AGENTS.md -> secret file holds a symlink, not the secret", async () => {
  await rm(`${workdir}/AGENTS.md`);
  await symlink(secretFile, `${workdir}/AGENTS.md`);
  await resync();
  const backup = await findBackup("AGENTS.md");
  expect((await lstat(backup)).isSymbolicLink()).toBe(true); // a link, so no secret bytes were copied
  expect(await readlink(backup)).toBe(secretFile);
  // The template's AGENTS.md replaced the link; the secret was never written.
  expect(lstatSync(`${workdir}/AGENTS.md`).isFile()).toBe(true);
  expect(readFileSync(`${workdir}/AGENTS.md`, "utf8")).toBe("# Lead\n");
  expect(readFileSync(secretFile, "utf8")).toBe("PRIVATE KEY");
});

test("projects/ as a symlink to a directory fails the start", async () => {
  await rm(`${workdir}/projects`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/projects`);
  await expect(prepareAgent()).rejects.toThrow(/is a symlink/);
  expect(readdirSync(hostDir)).toEqual([]);
});

test(".claude as a symlink fails the start and the re-sync, writing nothing through it", async () => {
  await rm(`${workdir}/.claude`, { recursive: true, force: true });
  await symlink(hostDir, `${workdir}/.claude`);
  await expect(prepareAgent()).rejects.toThrow(/is a symlink/);
  await expect(resync()).rejects.toThrow(/is a symlink/);
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

// Spec §11.7 (blocker R1): the reviewer's repro. A planted settings env reached git during
// `claude plugin marketplace add`; with a credential helper that is host code execution.
function withPlugins() {
  const config = { ...tpl.config, plugins: ["p@mk"] };
  tpl = {
    ...tpl,
    config,
    tplSettings: {
      extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/mk" } } },
    },
  };
  prep = {
    ...prep,
    effective: {
      doc: { ...prep.effective.doc, settings: tpl.tplSettings },
      config,
    },
  };
}
const pluginLog = (): { argv: string[]; env: string[]; cwd: string; configDir: string }[] => {
  try {
    return readFileSync(path.join(fake.dir, "plugin.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test("the install never sees the agent's config dir, cwd or settings (GIT_TRACE / GIT_CONFIG_* repro)", async () => {
  const marker = path.join(tmp("marker-"), "PWNED");
  const planted = {
    env: {
      GIT_TRACE: `${marker}-trace`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: `!touch ${marker}`,
    },
  };
  await writeFile(`${workdir}/.claude-config/settings.json`, JSON.stringify(planted));
  mkdirSync(`${workdir}/.claude`, { recursive: true });
  await writeFile(`${workdir}/.claude/settings.json`, JSON.stringify(planted));
  withPlugins();
  await resync();
  const runs = pluginLog();
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) {
    // r.env is the sorted key list the fake saw (its wrapper adds FAKE_CLAUDE_*): the planted keys must be absent
    expect(r.env).toEqual(expect.arrayContaining(["CLAUDE_CONFIG_DIR", "HOME", "PATH"]));
    for (const k of [
      "GIT_TRACE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "DATABASE_URL",
      "FACTORY_SECRET_KEY",
    ])
      expect(r.env).not.toContain(k);
    expect(r.cwd.startsWith(workdir)).toBe(false);
    expect(existsSync(r.cwd)).toBe(false); // a fresh temp dir, removed afterwards
    expect(r.configDir).toBe(pluginsConfigDir(home, "lead"));
  }
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(`${marker}-trace`)).toBe(false);
});

test("enabledPlugins and marketplaces come from plugins-config, not the agent's settings", async () => {
  withPlugins();
  await resync();
  await writeFile(
    `${workdir}/.claude-config/settings.json`,
    JSON.stringify({
      enabledPlugins: { "evil@m": true, "p@mk": true },
      extraKnownMarketplaces: { evil: { source: { source: "directory", path: "/evil" } } },
    }),
  );
  await prepareAgent();
  const s = JSON.parse(readFileSync(`${workdir}/.claude-config/settings.json`, "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  expect(s.extraKnownMarketplaces).not.toHaveProperty("evil");
});

test("a .claude-config/plugins symlink to a host dir is replaced, never followed", async () => {
  writeFileSync(path.join(hostDir, "keep"), "x");
  await symlink(hostDir, `${workdir}/.claude-config/plugins`);
  await prepareAgent();
  expect(await readlink(`${workdir}/.claude-config/plugins`)).toBe(
    `${pluginsConfigDir(home, "lead")}/plugins`,
  );
  expect(readdirSync(hostDir)).toEqual(["keep"]);
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

test("a Docker start's mounts pass checkMounts with the plugins dir and CLI bundle read-only", async () => {
  asDocker();
  const { mounts } = await prepareAgent();
  expect(mounts).toContainEqual({
    source: `${pluginsConfigDir(home, "lead")}/plugins`,
    target: `${pluginsConfigDir(home, "lead")}/plugins`,
    readOnly: true,
  });
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
    `Mount ${other} isn't allowed: it is inside FACTORY_HOME and isn't this agent's workdir or plugins dir.`,
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
