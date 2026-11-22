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

test("symlinks planted in template/ and resync/ are never moved into state", async () => {
  const { home, wd } = await setup();
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  await writeFile(path.join(outside, "secret"), "s3cret");
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await symlink(path.join(outside, "secret"), path.join(wd, ".factory/template/settings.json"));
  await mkdir(path.join(wd, ".factory/resync/with-link"), { recursive: true });
  await symlink(path.join(outside, "secret"), path.join(wd, ".factory/resync/with-link/AGENTS.md"));
  await symlink(outside, path.join(wd, ".factory/resync/2026-11-19T10-00-00Z"));
  await mkdir(path.join(wd, ".factory/resync/good"), { recursive: true });
  await writeFile(path.join(wd, ".factory/resync/good/AGENTS.md"), "ok");
  await migrateWorkdirState(home, ["a"], log);
  expect(await readFile(path.join(outside, "secret"), "utf8")).toBe("s3cret");
  expect(existsSync(`${home}/state/agents/a/template/settings.json`)).toBe(false);
  expect(existsSync(`${home}/state/agents/a/resync/with-link`)).toBe(false);
  expect(existsSync(`${home}/state/agents/a/resync/2026-11-19T10-00-00Z`)).toBe(false);
  expect(await readFile(`${home}/state/agents/a/resync/good/AGENTS.md`, "utf8")).toBe("ok");
  expect(existsSync(`${wd}/.factory`)).toBe(false);
});

test("a failing slug is logged and the others still migrate", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await writeFile(path.join(wd, ".factory/template/settings.json"), "{}");
  // state/agents/a is a file, so mkdir for slug "a" fails; slug "b" must still migrate.
  await mkdir(path.join(home, "state/agents"), { recursive: true });
  await writeFile(path.join(home, "state/agents/a"), "blocker");
  const wdB = path.join(home, "agents", "b");
  await mkdir(path.join(wdB, ".factory/template"), { recursive: true });
  await writeFile(path.join(wdB, ".factory/template/settings.json"), "{}");
  const warned: string[] = [];
  await migrateWorkdirState(home, ["a", "b"], { warn: (_o, m) => warned.push(m) });
  expect(warned.some((m) => m.includes("retries"))).toBe(true);
  expect(existsSync(`${home}/state/agents/b/template/settings.json`)).toBe(true);
  expect(existsSync(`${wd}/.factory`)).toBe(true);
});

test("U3 §13.5: .factory/uploads and anything else survive every boot; .factory goes only when empty", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/template"), { recursive: true });
  await writeFile(path.join(wd, ".factory/template/settings.json"), "{}");
  await mkdir(path.join(wd, ".factory/uploads"), { recursive: true });
  await writeFile(path.join(wd, ".factory/uploads/20261122-x-a.png"), "png");
  await writeFile(path.join(wd, ".factory/notes.txt"), "keep");
  await migrateWorkdirState(home, ["a"], log);
  await migrateWorkdirState(home, ["a"], log); // every boot runs it; idempotent
  expect(await readFile(`${wd}/.factory/uploads/20261122-x-a.png`, "utf8")).toBe("png");
  expect(await readFile(`${wd}/.factory/notes.txt`, "utf8")).toBe("keep");
  expect(existsSync(`${wd}/.factory/template`)).toBe(false);
  expect(await readFile(`${home}/state/agents/a/template/settings.json`, "utf8")).toBe("{}");
});

test("a .factory holding only uploads/ is left exactly as it is", async () => {
  const { home, wd } = await setup();
  await mkdir(path.join(wd, ".factory/uploads"), { recursive: true });
  await writeFile(path.join(wd, ".factory/uploads/x"), "x");
  await migrateWorkdirState(home, ["a"], log);
  expect(await readFile(`${wd}/.factory/uploads/x`, "utf8")).toBe("x");
  expect(existsSync(`${home}/state/agents/a`)).toBe(false);
});
