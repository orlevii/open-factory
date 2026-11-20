import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
    lock: new KeyedMutex(),
  });
  const tpl = { dir: tdir, config, tplSettings, tplMcp: { mcpServers: { x: { command: "x" } } } };
  const prep = {
    slug: "lead",
    displayName: "Lead",
    description: "d",
    template: "lead",
    config,
    manager: null,
    grants: [{ name: "app", hostPath: repo }],
  };
  return { home, hs, repo, ws, tpl, prep };
}

test("materialize then prepare: the full layout", async () => {
  const { ws, tpl, prep, repo, hs } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, ".claude/skills/local/SKILL.md"))).toBe(true);
  expect(existsSync(path.join(wd, "projects"))).toBe(false); // check-only at creation
  const out = await ws.prepare(prep);
  expect(lstatSync(path.join(wd, "projects/app")).isSymbolicLink()).toBe(true);
  expect(lstatSync(path.join(wd, ".claude/skills/grilling")).isSymbolicLink()).toBe(true);
  const s = JSON.parse(readFileSync(path.join(wd, ".claude-config/settings.json"), "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  expect(s.permissions.additionalDirectories).toEqual([repo]);
  expect(s.permissions.deny).toEqual(["Bash(curl:*)"]);
  expect(JSON.parse(readFileSync(path.join(wd, ".mcp.json"), "utf8"))).toEqual({
    mcpServers: { x: { command: "x" } },
  });
  expect(readFileSync(path.join(wd, ".claude-config/CLAUDE.md"), "utf8")).toContain("@lead");
  expect(out.mounts.map((m) => m.target)).toEqual([
    wd,
    repo,
    realpathSync(path.join(hs, "grilling")),
    "/mk",
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
  expect(again.permissions.deny).toEqual(["Bash(curl:*)"]);
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
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const wd = ws.workdir("lead");
  writeFileSync(path.join(wd, "AGENTS.md"), "# Lead\nlearned things\n");
  writeFileSync(path.join(wd, "mine.md"), "keep");
  const dir = await ws.resync("lead", tpl);
  expect(dir).toMatch(/^\.factory\/resync\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  expect(readFileSync(path.join(wd, dir as string, "AGENTS.md"), "utf8")).toContain("learned");
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("# Lead\n");
  expect(existsSync(path.join(wd, "mine.md"))).toBe(true);
  expect(await ws.resync("lead", tpl)).toBeUndefined();
});

test("prepare treats a non-object previous settings.json like a parse failure", async () => {
  for (const bad of ["null", "[1,2]", "7", "{nope"]) {
    const { ws, tpl, prep } = setup();
    await ws.materialize("lead", "lead", tpl, prep);
    const sp = path.join(ws.workdir("lead"), ".claude-config/settings.json");
    writeFileSync(sp, bad);
    await ws.prepare(prep);
    const s = JSON.parse(readFileSync(sp, "utf8"));
    expect(s.permissions.deny).toEqual(["Bash(curl:*)"]);
  }
});

test("prepare reports a missing or malformed template copy as a WorkspaceError", async () => {
  const { ws, tpl, prep } = setup();
  await ws.materialize("lead", "lead", tpl, prep);
  const copy = path.join(ws.workdir("lead"), ".factory/template");
  writeFileSync(path.join(copy, "settings.json"), "{nope");
  await expect(ws.prepare(prep)).rejects.toMatchObject({
    name: "WorkspaceError",
    message: expect.stringContaining("settings.json"),
  });
  writeFileSync(path.join(copy, "settings.json"), "{}");
  rmSync(path.join(copy, "mcp.json"));
  await expect(ws.prepare(prep)).rejects.toMatchObject({
    name: "WorkspaceError",
    message: expect.stringContaining("mcp.json"),
  });
});
