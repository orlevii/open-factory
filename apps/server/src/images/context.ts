import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "@balena/dockerignore";
import { isUserImageRef } from "@open-factory/shared";
import tar, { type Headers } from "tar-stream";

/** A bad image name or a folder that is not a direct child of images/ (400 invalid_image_name). */
export class ImageNameError extends Error {}
export class ContextLinkError extends Error {}

export type ContextEntry = {
  path: string;
  type: "file" | "link" | "dir";
  mode: number;
  target?: string;
};

/** Spec §10.2: the name matches the grammar and its real path is a direct child of the real images root. */
export async function imageDir(imagesRoot: string, name: string): Promise<string> {
  if (!isUserImageRef(name)) throw new ImageNameError(`Invalid image name "${name}".`);
  try {
    const realRoot = await realpath(imagesRoot);
    const real = await realpath(join(realRoot, name));
    if (dirname(real) !== realRoot) throw new Error("not a direct child");
    return real;
  } catch {
    throw new ImageNameError(`Invalid image name "${name}".`);
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
  const hasNegation = patterns.split("\n").some((l) => l.trim().startsWith("!"));
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
      out.push({ path: rel, type: "file", mode: st.mode & 0o7777 });
    }
    // sockets, fifos and devices are not part of a context
  };

  for (const child of await readdir(root)) await visit(join(root, child), child);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function contextHash(dir: string, name: string): Promise<string> {
  const root = resolve(dir);
  const h = createHash("sha256");
  for (const e of await walkContext(dir, name)) {
    h.update(e.path).update("\0").update(e.type).update("\0");
    if (e.type === "file") h.update(await readFile(join(root, e.path)));
    else if (e.type === "link") h.update(e.target ?? "");
    h.update("\0").update(String(e.mode));
  }
  return h.digest("hex");
}

export async function packContext(dir: string, name: string): Promise<NodeJS.ReadableStream> {
  const root = resolve(dir);
  const entries = await walkContext(dir, name); // throws before any byte is produced
  const pack = tar.pack();
  const epoch = new Date(0);
  const add = (header: Headers, body?: Buffer) =>
    new Promise<void>((res, rej) => {
      pack.entry(header, body, (err) => (err ? rej(err) : res()));
    });
  void (async () => {
    for (const e of entries) {
      const base = { name: e.path, mode: e.mode, mtime: epoch };
      if (e.type === "dir") await add({ ...base, type: "directory" });
      else if (e.type === "link") await add({ ...base, type: "symlink", linkname: e.target });
      else {
        const body = await readFile(join(root, e.path));
        await add({ ...base, type: "file", size: body.length }, body);
      }
    }
    pack.finalize();
  })().catch((err: unknown) => pack.destroy(err as Error));
  return pack;
}
