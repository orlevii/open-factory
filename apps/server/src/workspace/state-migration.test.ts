import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { migrateWorkdirState } from "./state-migration.ts";

const log = { warn: () => {} };

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "mig-"));
  const wd = path.join(home, "agents", "a");
  await mkdir(wd, { recursive: true });
  return { home, wd };
}

test("moves .factory/template and resync/* into state; removes .factory", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await writeFile(path.join(wd, ".factory/template/settings.json"), "{}");
  await writeFile(path.join(wd, ".factory/template/mcp.json"), '{"mcpServers":{}}');
  await mkdir(path.join(wd, ".factory/resync/2026-11-19T10-00-00Z"), { recursive: true });
  await writeFile(path.join(wd, ".factory/resync/2026-11-19T10-00-00Z/AGENTS.md"), "old");
  await migrateWorkdirState(home, ["a"], log);
  expect(await readFile(`${home}/state/agents/a/template/settings.json`, "utf8")).toBe("{}");
  expect(await readFile(`${home}/state/agents/a/template/mcp.json`, "utf8")).toBe(
    '{"mcpServers":{}}',
  );
  expect(existsSync(`${home}/state/agents/a/resync/2026-11-19T10-00-00Z/AGENTS.md`)).toBe(true);
  expect(existsSync(`${wd}/.factory`)).toBe(false);
});

test("a symlinked .factory is removed as a link, never followed", async () => {
  const { home, wd } = await setup();
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await mkdir(path.join(outside, "template"));
  await writeFile(path.join(outside, "template/settings.json"), "{}");
  await symlink(outside, `${wd}/.factory`);
  await migrateWorkdirState(home, ["a"], log);
  expect(existsSync(`${outside}/template/settings.json`)).toBe(true);
  expect(existsSync(`${wd}/.factory`)).toBe(false);
  expect(existsSync(`${home}/state/agents/a/template`)).toBe(false);
});

test("an existing target is kept and logged", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await writeFile(path.join(wd, ".factory/template/settings.json"), "old");
  await mkdir(path.join(home, "state/agents/a/template"), { recursive: true });
  await writeFile(path.join(home, "state/agents/a/template/settings.json"), "new");
  const warned: string[] = [];
  await migrateWorkdirState(home, ["a"], { warn: (_o, m) => warned.push(m) });
  expect(await readFile(`${home}/state/agents/a/template/settings.json`, "utf8")).toBe("new");
  expect(warned).toHaveLength(1);
  expect(existsSync(`${wd}/.factory`)).toBe(false);
});

test("idempotent: a second run is a no-op, and a missing workdir is fine", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await writeFile(path.join(wd, ".factory/template/settings.json"), "{}");
  await migrateWorkdirState(home, ["a", "ghost"], log);
  await migrateWorkdirState(home, ["a", "ghost"], log);
  expect(await readFile(`${home}/state/agents/a/template/settings.json`, "utf8")).toBe("{}");
});
