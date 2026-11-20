import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tar from "tar-stream";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ContextChangedError,
  ContextLinkError,
  contextHash,
  ImageNameError,
  imageDir,
  packContext,
  packEntries,
  walkContext,
} from "./context.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "of-ctx-"));
  await mkdir(join(root, "images"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const mk = async (name = "img") => {
  const dir = join(root, "images", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
  return dir;
};

test("imageDir accepts a plain child and refuses bad names and escaping links", async () => {
  const dir = await mk("ok");
  await expect(imageDir(join(root, "images"), "ok")).resolves.toBe(
    await import("node:fs/promises").then((f) => f.realpath(dir)),
  );
  for (const bad of ["..", "a/b", "Upper", ".hidden", ""])
    await expect(imageDir(join(root, "images"), bad)).rejects.toBeInstanceOf(ImageNameError);
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "images", "evil"));
  await expect(imageDir(join(root, "images"), "evil")).rejects.toBeInstanceOf(ImageNameError);
  await expect(imageDir(join(root, "images"), "missing")).rejects.toBeInstanceOf(ImageNameError);
});

test(".dockerignore excludes node_modules and honours a negation", async () => {
  const dir = await mk();
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "node_modules", "x.js"), "x");
  await writeFile(join(dir, "a.txt"), "a");
  await writeFile(join(dir, "keep.txt"), "k");
  await writeFile(join(dir, ".dockerignore"), "node_modules\n*.txt\n!keep.txt\n");
  const paths = (await walkContext(dir, "img")).map((e) => e.path);
  expect(paths).toEqual([".dockerignore", "Dockerfile", "keep.txt"]);
});

test("a link to a file inside is packed as a link entry", async () => {
  const dir = await mk();
  await writeFile(join(dir, "real.txt"), "r");
  await symlink("real.txt", join(dir, "ln"));
  const pack = await packContext(dir, "img");
  const ex = tar.extract();
  const seen: Record<string, { type?: string | null; linkname?: string | null; body: string }> = {};
  ex.on("entry", (h, s, next) => {
    const chunks: Buffer[] = [];
    s.on("data", (c: Buffer) => chunks.push(c));
    s.on("end", () => {
      seen[h.name] = { type: h.type, linkname: h.linkname, body: Buffer.concat(chunks).toString() };
      next();
    });
  });
  const done = new Promise((res, rej) => {
    ex.on("finish", res);
    ex.on("error", rej);
  });
  pack.pipe(ex);
  await done;
  expect(seen.ln).toMatchObject({ type: "symlink", linkname: "real.txt" });
  expect(seen["real.txt"]).toMatchObject({ type: "file", body: "r" });
  expect(seen.Dockerfile?.body).toBe("FROM scratch\n");
});

test("a link that leaves the folder fails with the exact sentence", async () => {
  const dir = await mk("playwright");
  await mkdir(join(dir, "sub"));
  await symlink("../../etc/passwd", join(dir, "sub", "pw"));
  const err = await walkContext(dir, "playwright").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ContextLinkError);
  expect((err as Error).message).toBe(
    "images/playwright/sub/pw links outside the folder. Copy the file into the folder instead.",
  );
  await expect(contextHash(dir, "playwright")).rejects.toBeInstanceOf(ContextLinkError);
  await expect(packContext(dir, "playwright")).rejects.toBeInstanceOf(ContextLinkError);
});

test("an absolute link outside the folder fails too", async () => {
  const dir = await mk();
  await symlink("/etc/passwd", join(dir, "abs"));
  await expect(walkContext(dir, "img")).rejects.toBeInstanceOf(ContextLinkError);
});

test("the hash is stable and changes with content, mode and a link target", async () => {
  const dir = await mk();
  await writeFile(join(dir, "a"), "1");
  await writeFile(join(dir, "b"), "b");
  await symlink("a", join(dir, "ln"));
  const h0 = await contextHash(dir, "img");
  expect(await contextHash(dir, "img")).toBe(h0);
  expect(h0).toMatch(/^[0-9a-f]{64}$/);

  await writeFile(join(dir, "a"), "2");
  const h1 = await contextHash(dir, "img");
  expect(h1).not.toBe(h0);

  await chmod(join(dir, "a"), 0o755);
  const h2 = await contextHash(dir, "img");
  expect(h2).not.toBe(h1);

  await rm(join(dir, "ln"));
  await symlink("b", join(dir, "ln"));
  expect(await contextHash(dir, "img")).not.toBe(h2);
});

test("a file excluded by .dockerignore does not change the hash", async () => {
  const dir = await mk();
  await writeFile(join(dir, ".dockerignore"), "secret\n");
  await writeFile(join(dir, "secret"), "1");
  const h0 = await contextHash(dir, "img");
  await writeFile(join(dir, "secret"), "2");
  expect(await contextHash(dir, "img")).toBe(h0);
});

test("ImageNameError quotes the name as JSON, so control characters are escaped", async () => {
  const err = await imageDir(join(root, "images"), "a\0b").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ImageNameError);
  expect((err as Error).message).toBe('Invalid image name "a\\u0000b".');
});

test("an unchanged folder's hash comes from the cache (one lstat walk); a changed size reads again", async () => {
  const dir = await mk();
  await writeFile(join(dir, "a"), "1");
  const old = new Date(Date.now() - 60_000);
  const age = async () => {
    for (const f of ["Dockerfile", "a"]) await utimes(join(dir, f), old, old);
  };
  await age();
  const h0 = await contextHash(dir, "img");
  // Same size, same inode, mtime put back: the walk's signature is unchanged, so the bytes aren't read.
  await writeFile(join(dir, "a"), "2");
  await age();
  expect(await contextHash(dir, "img")).toBe(h0);
  await writeFile(join(dir, "a"), "22");
  await age();
  expect(await contextHash(dir, "img")).not.toBe(h0);
});

/** Drains a pack, resolving with the error it ends with (or undefined). */
const drain = (pack: NodeJS.ReadableStream) =>
  new Promise<unknown>((res) => {
    pack.on("data", () => {});
    pack.on("end", () => res(undefined));
    pack.on("error", res);
  });

test("the pack never reads through a file swapped for a link after the walk", async () => {
  const dir = await mk();
  await writeFile(join(dir, "a"), "1");
  await writeFile(join(root, "outside"), "secret");
  const entries = await walkContext(dir, "img");
  await rm(join(dir, "a"));
  await symlink(join(root, "outside"), join(dir, "a"));
  expect(await drain(packEntries(dir, "img", entries))).toBeInstanceOf(ContextChangedError);
});

test("the pack fails, without hanging, on a file swapped for a FIFO after the walk", async () => {
  const dir = await mk();
  await writeFile(join(dir, "a"), "1");
  const entries = await walkContext(dir, "img");
  await rm(join(dir, "a"));
  execFileSync("mkfifo", [join(dir, "a")]);
  expect((await stat(join(dir, "a"))).isFIFO()).toBe(true);
  expect(await drain(packEntries(dir, "img", entries))).toBeInstanceOf(ContextChangedError);
});
