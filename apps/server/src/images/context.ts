import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ignore from "@balena/dockerignore";
import { isUserImageRef } from "@open-factory/shared";
import tar, { type Headers } from "tar-stream";

/** A bad image name or a folder that is not a direct child of images/ (400 invalid_image_name). */
export class ImageNameError extends Error {}
export class ContextLinkError extends Error {}
/** A file changed between the walk and its read (it was replaced, resized, or became a link or a FIFO). */
export class ContextChangedError extends Error {}

export type ContextEntry = {
  path: string;
  type: "file" | "link" | "dir";
  mode: number;
  target?: string;
  /** Files only: what the walk's lstat saw; a read checks the open file against it. */
  size?: number;
  mtimeMs?: number;
  ino?: number;
};

/**
 * Spec §10.2: the name matches the grammar and its real path is a direct child of the real images root. The
 * folder itself must not be a link (even to a sibling), so validation agrees with listImages, which keeps only
 * real directories.
 */
export async function imageDir(imagesRoot: string, name: string): Promise<string> {
  const invalid = () => new ImageNameError(`Invalid image name ${JSON.stringify(name)}.`);
  if (!isUserImageRef(name)) throw invalid();
  try {
    const realRoot = await realpath(imagesRoot);
    if (!(await lstat(join(realRoot, name))).isDirectory()) throw new Error("not a real folder");
    const real = await realpath(join(realRoot, name));
    if (dirname(real) !== realRoot) throw new Error("not a direct child");
    return real;
  } catch {
    throw invalid();
  }
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** One walk serves the hash and the tar. Links are never followed. */
export async function walkContext(dir: string, name: string): Promise<ContextEntry[]> {
  const root = resolve(dir);
  let patterns = "";
  try {
    patterns = await readFile(join(root, ".dockerignore"), "utf8");
  } catch {}
  const ig = ignore().add(patterns);
  const hasNegation = patterns.split(/\r?\n/).some((l) => l.trim().startsWith("!"));
  const out: ContextEntry[] = [];

  const visit = async (abs: string, rel: string): Promise<void> => {
    const st = await lstat(abs);
    const kept = rel === "Dockerfile" || rel === ".dockerignore" || !ig.ignores(rel);
    if (st.isDirectory()) {
      // An ignored folder is pruned unless a negation could re-include something below it.
      if (!kept && !hasNegation) return;
      if (kept) out.push({ path: rel, type: "dir", mode: st.mode & 0o7777 });
      for (const child of await readdir(abs)) await visit(join(abs, child), `${rel}/${child}`);
      return;
    }
    if (!kept) return;
    if (st.isSymbolicLink()) {
      const target = await readlink(abs);
      if (!inside(root, resolve(dirname(abs), target)))
        throw new ContextLinkError(
          `images/${name}/${rel} links outside the folder. Copy the file into the folder instead.`,
        );
      out.push({ path: rel, type: "link", mode: st.mode & 0o7777, target });
    } else if (st.isFile()) {
      out.push({
        path: rel,
        type: "file",
        mode: st.mode & 0o7777,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ino: st.ino,
      });
    }
    // sockets, fifos and devices are not part of a context
  };

  for (const child of await readdir(root)) await visit(join(root, child), child);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Streams one walked file into `sink`, never through a link (O_NOFOLLOW) and never blocking on a FIFO
 * (O_NONBLOCK): the open file must still be the regular file the walk saw, and exactly its size is read.
 */
async function readWalked(
  root: string,
  name: string,
  e: ContextEntry,
  sink: (body: Readable) => Promise<void>,
): Promise<void> {
  const changed = () =>
    new ContextChangedError(`images/${name}/${e.path} changed while it was read. Build again.`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fh = await open(join(root, e.path), flags).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ELOOP" || err.code === "ENOENT" ? changed() : err;
  });
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.ino !== e.ino || st.size !== e.size || st.mtimeMs !== e.mtimeMs)
      throw changed();
    if (st.size === 0) return await sink(Readable.from([]));
    await sink(fh.createReadStream({ start: 0, end: st.size - 1, autoClose: false }));
  } finally {
    await fh.close();
  }
}

/** The walk's signature: what the hash cache trusts instead of reading every byte again. */
const signature = (entries: ContextEntry[]) =>
  JSON.stringify(entries.map((e) => [e.path, e.type, e.size, e.mtimeMs, e.ino, e.mode, e.target]));

/**
 * A file modified this recently may change again within the file system's mtime granularity without
 * its mtime moving (racy-git), so a walk with such a file is always read in full.
 */
const RACY_MS = 2000;
const hashCache = new Map<string, { sig: string; hash: string }>();

/**
 * The context hash of walked entries (spec §10.4): path, type, bytes or link target, and mode. Files are
 * streamed, and the result is cached per folder keyed by the walk's signature, so an unchanged folder
 * costs one lstat walk.
 */
export async function hashEntries(
  dir: string,
  name: string,
  entries: ContextEntry[],
): Promise<string> {
  const root = resolve(dir);
  const sig = signature(entries);
  const cached = hashCache.get(root);
  if (cached?.sig === sig) return cached.hash;
  const startedMs = Date.now();
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(e.path).update("\0").update(e.type).update("\0");
    if (e.type === "file") await readWalked(root, name, e, (body) => feed(body, h));
    else if (e.type === "link") h.update(e.target ?? "");
    h.update("\0").update(String(e.mode));
  }
  const hash = h.digest("hex");
  const newest = Math.max(0, ...entries.map((e) => e.mtimeMs ?? 0));
  if (newest + RACY_MS < startedMs) hashCache.set(root, { sig, hash });
  else hashCache.delete(root);
  return hash;
}

async function feed(body: Readable, h: Hash) {
  for await (const chunk of body) h.update(chunk as Buffer);
}

export async function contextHash(dir: string, name: string): Promise<string> {
  return hashEntries(dir, name, await walkContext(dir, name));
}

/** The tar of walked entries, read the same way as the hash (no link following, same files as walked). */
export function packEntries(dir: string, name: string, entries: ContextEntry[]): Readable {
  const root = resolve(dir);
  const pack = tar.pack();
  const epoch = new Date(0);
  const add = (header: Headers) =>
    new Promise<void>((res, rej) => {
      pack.entry(header, (err) => (err ? rej(err) : res()));
    });
  void (async () => {
    for (const e of entries) {
      const base = { name: e.path, mode: e.mode, mtime: epoch };
      if (e.type === "dir") await add({ ...base, type: "directory" });
      else if (e.type === "link") await add({ ...base, type: "symlink", linkname: e.target });
      else
        await readWalked(root, name, e, (body) =>
          pipeline(body, pack.entry({ ...base, type: "file", size: e.size })),
        );
    }
    pack.finalize();
  })().catch((err: unknown) => pack.destroy(err as Error));
  return pack;
}

export async function packContext(dir: string, name: string): Promise<Readable> {
  // The walk throws before any byte is produced.
  return packEntries(dir, name, await walkContext(dir, name));
}
