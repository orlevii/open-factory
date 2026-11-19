import { lstat, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { agentWorkdir, resyncRoot, templateCopyDir } from "./paths.ts";

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

/** Moves each child of `from` (real entries only) into `to`; a target that exists is skipped and logged. */
async function moveChildren(from: string, to: string, slug: string, log: Log): Promise<void> {
  const names = await entries(from);
  if (!names.length) return;
  await mkdir(to, { recursive: true });
  for (const name of names) {
    const dest = path.join(to, name);
    if (await exists(dest)) {
      log.warn({ slug, target: dest }, "state target already exists; left the old copy behind");
      continue;
    }
    await rename(path.join(from, name), dest);
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
    const old = path.join(agentWorkdir(factoryHome, slug), ".factory");
    const st = await lstat(old).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      await unlink(old);
      continue;
    }
    for (const [sub, dest] of [
      ["template", templateCopyDir(factoryHome, slug)],
      ["resync", resyncRoot(factoryHome, slug)],
    ] as const) {
      const src = path.join(old, sub);
      const sst = await lstat(src).catch(() => null);
      if (sst?.isDirectory()) await moveChildren(src, dest, slug, log);
    }
    await rm(old, { recursive: true, force: true });
  }
}
