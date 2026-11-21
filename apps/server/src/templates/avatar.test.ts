import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { avatarStat, MAX_AVATAR_BYTES, readAvatar } from "./avatar.ts";

// On macOS tmpdir() sits under a symlinked parent (/var → /private/var): the inside check compares realpaths.
const tpl = () => mkdtemp(path.join(tmpdir(), "tpl-"));

test("version from mtime and size; null when missing, too large or not a file", async () => {
  const dir = await tpl();
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(dir)).toBeNull();
  await writeFile(path.join(dir, "avatar.svg"), "<svg/>");
  const { version } = await avatarStat(dir);
  expect(version).toMatch(/^\d+-6$/);
  const read = await readAvatar(dir);
  expect(read?.version).toBe(version);
  expect(read?.body.toString()).toBe("<svg/>");
  await writeFile(path.join(dir, "avatar.svg"), "x".repeat(MAX_AVATAR_BYTES));
  expect((await avatarStat(dir)).version).toMatch(new RegExp(`^\\d+-${MAX_AVATAR_BYTES}$`));
  await writeFile(path.join(dir, "avatar.svg"), "x".repeat(256 * 1024 + 1));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: true });
  expect(await readAvatar(dir)).toBeNull();
  await rm(path.join(dir, "avatar.svg"));
  await mkdir(path.join(dir, "avatar.svg"));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(dir)).toBeNull();
});

test("a symlinked avatar.svg is absent, even when it points inside the folder", async () => {
  const dir = await tpl();
  await writeFile(path.join(dir, "real.svg"), "<svg/>");
  await symlink(path.join(dir, "real.svg"), path.join(dir, "avatar.svg"));
  expect((await avatarStat(dir)).version).toBeNull();
  expect(await readAvatar(dir)).toBeNull();
  const outside = await mkdtemp(path.join(tmpdir(), "out-"));
  await writeFile(path.join(outside, "x.svg"), "<svg/>");
  await rm(path.join(dir, "avatar.svg"));
  await symlink(path.join(outside, "x.svg"), path.join(dir, "avatar.svg"));
  expect((await avatarStat(dir)).version).toBeNull();
  expect(await readAvatar(dir)).toBeNull();
  // A relative link climbing out of the folder, and one to a big file (never tooLarge: it is absent).
  await rm(path.join(dir, "avatar.svg"));
  await writeFile(path.join(outside, "big.svg"), "x".repeat(MAX_AVATAR_BYTES + 1));
  await symlink(path.relative(dir, path.join(outside, "big.svg")), path.join(dir, "avatar.svg"));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(dir)).toBeNull();
});

test("a dangling symlink and a template dir that does not exist are absent", async () => {
  const dir = await tpl();
  await symlink(path.join(dir, "missing.svg"), path.join(dir, "avatar.svg"));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(dir)).toBeNull();
  expect(await avatarStat(path.join(dir, "nope"))).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(path.join(dir, "nope"))).toBeNull();
});

test("a hard link inside the template folder is absent (nlink > 1), also after the other name is removed it is served again", async () => {
  const dir = await tpl();
  const outside = await tpl();
  await writeFile(path.join(outside, "secret.svg"), "<svg>secret</svg>");
  await link(path.join(outside, "secret.svg"), path.join(dir, "avatar.svg"));
  expect(await avatarStat(dir)).toEqual({ version: null, tooLarge: false });
  expect(await readAvatar(dir)).toBeNull();
  await rm(path.join(outside, "secret.svg"));
  expect((await avatarStat(dir)).version).not.toBeNull();
});

test("a template folder that is a symlink out of the templates root is absent", async () => {
  const root = await tpl();
  const elsewhere = await tpl();
  await writeFile(path.join(elsewhere, "avatar.svg"), "<svg/>");
  await symlink(elsewhere, path.join(root, "evil"));
  await mkdir(path.join(root, "good"));
  await writeFile(path.join(root, "good", "avatar.svg"), "<svg/>");
  expect(await avatarStat(path.join(root, "evil"), root)).toEqual({
    version: null,
    tooLarge: false,
  });
  expect(await readAvatar(path.join(root, "evil"), root)).toBeNull();
  expect((await avatarStat(path.join(root, "good"), root)).version).not.toBeNull();
  expect(await readAvatar(path.join(root, "good"), root)).not.toBeNull();
});
