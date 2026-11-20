import { lstat, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { agentWorkdir, resyncRoot, templateCopyDir } from "./paths.ts";

const TEMPLATE_FILES = new Set(["settings.json", "mcp.json"]);

type Log = { warn: (o: object, msg: string) => void };

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** True when `dir` holds any symlink or non-regular entry at any depth (lstat only, never followed). */
async function hasLinks(dir: string): Promise<boolean> {
  for (const name of await entries(dir)) {
    const p = path.join(dir, name);
    const st = await lstat(p);
    if (st.isDirectory()) {
      if (await hasLinks(p)) return true;
    } else if (!st.isFile()) return true;
  }
  return false;
}

/**
 * Moves the acceptable children of `from` into `to`. `kind` decides what is acceptable: the template
 * copy takes only the two regular files, the resync root only real directories holding no links.
 * Anything else is skipped with a warning (and removed with `.factory`); a target that exists is
 * skipped and logged.
 */
async function moveChildren(
  from: string,
  to: string,
  kind: "template" | "resync",
  slug: string,
  log: Log,
): Promise<void> {
  const names = await entries(from);
  if (!names.length) return;
  await mkdir(to, { recursive: true });
  for (const name of names) {
    const src = path.join(from, name);
    const st = await lstat(src);
    const ok =
      kind === "template"
        ? st.isFile() && TEMPLATE_FILES.has(name)
        : st.isDirectory() && !(await hasLinks(src));
    if (!ok) {
      log.warn({ slug, source: src }, "not a plain factory state entry; left behind and removed");
      continue;
    }
    const dest = path.join(to, name);
    if (await exists(dest)) {
      log.warn({ slug, target: dest }, "state target already exists; left the old copy behind");
      continue;
    }
    await rename(src, dest);
  }
}

/**
 * One-time move of S4's factory state out of each agent's writable workdir (spec §11.7). A symlinked
 * `.factory` is unlinked, never followed. Idempotent: nothing to do once `.factory` is gone.
 */
export async function migrateWorkdirState(
  factoryHome: string,
  slugs: string[],
  log: Log,
): Promise<void> {
  for (const slug of slugs) {
    try {
      await migrateOne(factoryHome, slug, log);
    } catch (err) {
      log.warn({ slug, err }, "state migration failed; it retries on the next boot");
    }
  }
}

async function migrateOne(factoryHome: string, slug: string, log: Log): Promise<void> {
  {
    const old = path.join(agentWorkdir(factoryHome, slug), ".factory");
    const st = await lstat(old).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      await unlink(old);
      return;
    }
    for (const [sub, dest] of [
      ["template", templateCopyDir(factoryHome, slug)],
      ["resync", resyncRoot(factoryHome, slug)],
    ] as const) {
      const src = path.join(old, sub);
      const sst = await lstat(src).catch(() => null);
      if (sst?.isDirectory()) await moveChildren(src, dest, sub, slug, log);
    }
    await rm(old, { recursive: true, force: true });
  }
}
