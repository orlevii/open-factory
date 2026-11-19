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
import { lstat, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { templateYamlSchema } from "@open-factory/shared";
import { beforeEach, expect, test } from "vitest";
import { KeyedMutex } from "./lock.ts";
import { resyncRoot } from "./paths.ts";
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
  ws = new Workspace({
    factoryHome: home,
    hostSkillsDir: hs,
    claudeBin: createFakeClaude({ scenario: "reply" }).bin,
    lock: new KeyedMutex(),
  });
  tpl = { dir: tdir, config, tplSettings: {}, tplMcp: { mcpServers: {} } };
  prep = {
    slug: "lead",
    displayName: "Lead",
    description: "d",
    template: "lead",
    config,
    manager: null,
    grants: [{ name: "app", hostPath: repo }],
  };
  await ws.materialize("lead", "lead", tpl, prep);
  workdir = ws.workdir("lead");
});

const prepareAgent = () => ws.prepare(prep);
const resync = () => ws.resync("lead", tpl);
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
