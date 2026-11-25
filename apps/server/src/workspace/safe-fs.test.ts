import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SafeFs, UnsafePathError, WorkspaceError } from "./safe-fs.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

test("writeFile refuses a symlinked parent: the refusal names the path and is a WorkspaceError", async () => {
  const wd = tmp("wd-");
  const hostDir = tmp("host-");
  mkdirSync(`${wd}/a`);
  symlinkSync(hostDir, `${wd}/a/b`);
  const err = await new SafeFs(wd).writeFile("a/b/c/x.md", "x").catch((e) => e);
  expect(err).toBeInstanceOf(WorkspaceError);
  expect(err).toBeInstanceOf(UnsafePathError);
  expect(err.message).toBe(`${wd}/a/b is a symlink; the factory won't write through it.`);
  expect(readdirSync(hostDir)).toEqual([]);
  // A symlink directly under the root is refused the same way.
  symlinkSync(hostDir, `${wd}/.claude-config`);
  await expect(new SafeFs(wd).writeFile(".claude-config/settings.json", "{}")).rejects.toThrow(
    /is a symlink/,
  );
  expect(existsSync(`${hostDir}/settings.json`)).toBe(false);
});

test("writeFile creates parents, writes atomically, applies the mode, replaces a link without following it", async () => {
  const wd = tmp("wd-");
  const secret = path.join(tmp("secret-"), "id");
  writeFileSync(secret, "secret");
  const fs = new SafeFs(wd);
  await fs.writeFile("a/b/c.md", "one", 0o444);
  expect(readFileSync(`${wd}/a/b/c.md`, "utf8")).toBe("one");
  expect(statSync(`${wd}/a/b/c.md`).mode & 0o777).toBe(0o444);
  await fs.writeFile("a/b/c.md", Buffer.from("two"));
  expect(readFileSync(`${wd}/a/b/c.md`, "utf8")).toBe("two");
  symlinkSync(secret, `${wd}/AGENTS.md`);
  await fs.writeFile("AGENTS.md", "mine");
  expect(lstatSync(`${wd}/AGENTS.md`).isFile()).toBe(true);
  expect(readFileSync(secret, "utf8")).toBe("secret");
  expect(readdirSync(`${wd}/a/b`)).toEqual(["c.md"]);
});

test("paths that leave the root are refused", async () => {
  const wd = tmp("wd-");
  const fs = new SafeFs(wd);
  for (const rel of ["../x", "/etc/x", "a/../../x", ""]) {
    await expect(fs.writeFile(rel, "x")).rejects.toBeInstanceOf(WorkspaceError);
  }
});

test("a file where a folder is expected is refused", async () => {
  const wd = tmp("wd-");
  writeFileSync(`${wd}/projects`, "x");
  await expect(new SafeFs(wd).mkdirp("projects")).rejects.toThrow(/isn't a folder/);
  await expect(new SafeFs(wd).writeFile("projects/a", "x")).rejects.toBeInstanceOf(WorkspaceError);
});

test("mkdirp and assertParents refuse links at any depth", async () => {
  const wd = tmp("wd-");
  const hostDir = tmp("host-");
  mkdirSync(`${wd}/.claude`);
  symlinkSync(hostDir, `${wd}/.claude/skills`);
  const fs = new SafeFs(wd);
  await expect(fs.mkdirp(".claude/skills/x")).rejects.toBeInstanceOf(UnsafePathError);
  await expect(fs.mkdirp(".claude/skills")).rejects.toBeInstanceOf(UnsafePathError);
  await expect(fs.assertParents(".claude/skills/x/SKILL.md")).rejects.toBeInstanceOf(
    UnsafePathError,
  );
  await fs.assertParents(".claude/skills"); // the entry itself isn't a parent
  expect(readdirSync(hostDir)).toEqual([]);
});

test("a symlinked root is refused", async () => {
  const real = tmp("real-");
  const outer = tmp("outer-");
  symlinkSync(real, `${outer}/wd`);
  await expect(new SafeFs(`${outer}/wd`).writeFile("x", "x")).rejects.toBeInstanceOf(
    UnsafePathError,
  );
  expect(readdirSync(real)).toEqual([]);
});

test("link creates and replaces factory links, never touches a real entry", async () => {
  const wd = tmp("wd-");
  const a = tmp("a-");
  const b = tmp("b-");
  const fs = new SafeFs(wd);
  await fs.link("projects/app", a);
  expect(readlinkSync(`${wd}/projects/app`)).toBe(a);
  await fs.link("projects/app", b);
  expect(readlinkSync(`${wd}/projects/app`)).toBe(b);
  mkdirSync(`${wd}/projects/real`);
  await expect(fs.link("projects/real", a)).rejects.toBeInstanceOf(WorkspaceError);
  expect(lstatSync(`${wd}/projects/real`).isDirectory()).toBe(true);
  expect(readdirSync(`${wd}/projects`).sort()).toEqual(["app", "real"]);
});

test("removeLink removes only a symlink", async () => {
  const wd = tmp("wd-");
  const a = tmp("a-");
  writeFileSync(`${a}/keep`, "x");
  const fs = new SafeFs(wd);
  await fs.link("projects/app", a);
  await fs.removeLink("projects/app");
  expect(existsSync(`${wd}/projects/app`)).toBe(false);
  expect(existsSync(`${a}/keep`)).toBe(true);
  await fs.removeLink("projects/gone");
  await fs.removeLink("nothing/here");
  writeFileSync(`${wd}/projects/file`, "x");
  await expect(fs.removeLink("projects/file")).rejects.toBeInstanceOf(WorkspaceError);
  expect(existsSync(`${wd}/projects/file`)).toBe(true);
});

test("copyOut copies a regular file's bytes and a symlink as a symlink", async () => {
  const wd = tmp("wd-");
  const out = tmp("out-");
  const secret = path.join(tmp("secret-"), "id");
  writeFileSync(secret, "secret");
  writeFileSync(`${wd}/a.md`, "mine");
  symlinkSync(secret, `${wd}/b.md`);
  const fs = new SafeFs(wd);
  await fs.copyOut("a.md", `${out}/a.md`);
  await fs.copyOut("b.md", `${out}/b.md`);
  expect(readFileSync(`${out}/a.md`, "utf8")).toBe("mine");
  expect(lstatSync(`${out}/b.md`).isSymbolicLink()).toBe(true);
  expect(readlinkSync(`${out}/b.md`)).toBe(secret);
  await expect(fs.copyOut("a.md", `${out}/a.md`)).rejects.toMatchObject({ code: "EEXIST" });
  mkdirSync(`${wd}/dir.md`);
  await expect(fs.copyOut("dir.md", `${out}/dir.md`)).rejects.toBeInstanceOf(WorkspaceError);
});

test("readIfRegular: bytes for a file; undefined for missing, a symlink, a folder or a fifo", async () => {
  const wd = tmp("wd-");
  const secret = path.join(tmp("secret-"), "id");
  writeFileSync(secret, "secret");
  writeFileSync(`${wd}/a.md`, "mine");
  symlinkSync(secret, `${wd}/b.md`);
  mkdirSync(`${wd}/dir`);
  execFileSync("mkfifo", [`${wd}/pipe`]);
  const fs = new SafeFs(wd);
  expect((await fs.readIfRegular("a.md"))?.toString()).toBe("mine");
  expect(await fs.readIfRegular("b.md")).toBeUndefined();
  expect(await fs.readIfRegular("missing.md")).toBeUndefined();
  expect(await fs.readIfRegular("no/such/dir.md")).toBeUndefined();
  expect(await fs.readIfRegular("dir")).toBeUndefined();
  expect(await fs.readIfRegular("pipe")).toBeUndefined(); // must not block on open
  symlinkSync(tmp("host-"), `${wd}/linked`);
  await expect(fs.readIfRegular("linked/x")).rejects.toBeInstanceOf(UnsafePathError);
});

test("removeAll removes the root tree without following links; a symlinked root is only unlinked", async () => {
  const outer = tmp("outer-");
  const host = tmp("host-");
  writeFileSync(`${host}/keep`, "x");
  mkdirSync(`${outer}/wd/sub`, { recursive: true });
  symlinkSync(host, `${outer}/wd/sub/link`);
  await new SafeFs(`${outer}/wd`).removeAll();
  expect(existsSync(`${outer}/wd`)).toBe(false);
  expect(existsSync(`${host}/keep`)).toBe(true);
  symlinkSync(host, `${outer}/wd2`);
  await new SafeFs(`${outer}/wd2`).removeAll();
  expect(existsSync(`${outer}/wd2`)).toBe(false);
  expect(existsSync(`${host}/keep`)).toBe(true);
  await new SafeFs(`${outer}/missing`).removeAll();
});

test.skipIf(process.getuid?.() === 0)(
  "emptyDir removes everything it can when one entry won't go, then reports the failure",
  async () => {
    const wd = tmp("wd-");
    mkdirSync(`${wd}/box/locked`, { recursive: true });
    writeFileSync(`${wd}/box/locked/stuck`, "x");
    writeFileSync(`${wd}/box/a`, "a");
    writeFileSync(`${wd}/box/z`, "z");
    chmodSync(`${wd}/box/locked`, 0o555);
    try {
      await expect(new SafeFs(wd).emptyDir("box")).rejects.toThrow();
      expect(readdirSync(`${wd}/box`)).toEqual(["locked"]);
    } finally {
      chmodSync(`${wd}/box/locked`, 0o755);
    }
  },
);
