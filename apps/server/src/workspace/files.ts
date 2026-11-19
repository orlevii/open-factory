import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./links.ts";

export async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function walk(root: string, rel = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else out.push(r);
  }
  return out;
}

export async function templateTargets(
  tplDir: string,
  cfg: { localSkills: boolean },
): Promise<{ from: string; to: string }[]> {
  const out: { from: string; to: string }[] = [];
  const agents = path.join(tplDir, "AGENTS.md");
  if (
    await lstat(agents).then(
      () => true,
      () => false,
    )
  )
    out.push({ from: agents, to: "AGENTS.md" });
  if (cfg.localSkills) {
    for (const r of await walk(path.join(tplDir, "skills"))) {
      out.push({ from: path.join(tplDir, "skills", r), to: path.join(".claude", "skills", r) });
    }
  }
  for (const r of await walk(path.join(tplDir, "files"))) {
    out.push({ from: path.join(tplDir, "files", r), to: r });
  }
  return out;
}

/** Create the parent directories of `rel` under `workdir`, refusing any component that is a symlink
 *  (a link into a granted repo or host skill must never be written through). */
async function safeParent(workdir: string, rel: string): Promise<string> {
  let cur = workdir;
  for (const part of path
    .dirname(rel)
    .split(path.sep)
    .filter((p) => p && p !== ".")) {
    cur = path.join(cur, part);
    let st = await lstat(cur).catch(() => null);
    if (!st) {
      await mkdir(cur);
      st = await lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WorkspaceError(
        `${path.relative(workdir, cur)} is a link or not a folder, so the template can't write ${rel} there; move it away.`,
      );
    }
  }
  return cur;
}

export async function copyTargets(
  _tplDir: string,
  workdir: string,
  templateCopy: string,
  targets: { from: string; to: string }[],
  tplSettings: Record<string, unknown>,
  tplMcp: unknown,
): Promise<void> {
  for (const t of targets) {
    const parent = await safeParent(workdir, t.to);
    const dest = path.join(parent, path.basename(t.to));
    const tmp = `${dest}.tmp-${randomUUID()}`;
    const st = await lstat(t.from);
    const existing = await lstat(dest).catch(() => null);
    try {
      if (st.isSymbolicLink()) {
        if (existing && !existing.isSymbolicLink()) {
          throw new WorkspaceError(
            `${t.to} exists and isn't a link, so the template link can't replace it; move it away.`,
          );
        }
        await symlink(await readlink(t.from), tmp);
      } else {
        await copyFile(t.from, tmp);
        await chmod(tmp, st.mode & 0o777);
      }
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
  await writeAtomic(path.join(templateCopy, "settings.json"), JSON.stringify(tplSettings, null, 2));
  await writeAtomic(path.join(templateCopy, "mcp.json"), JSON.stringify(tplMcp, null, 2));
}

/** Copies the workdir files an incoming template would change into `<backupRoot>/<stamp>/`.
 *  Returns that absolute dir, or undefined when nothing differed. */
export async function backupDiffering(
  workdir: string,
  backupRoot: string,
  incoming: { to: string; data: Buffer }[],
  stamp: string,
): Promise<string | undefined> {
  const dir = path.join(backupRoot, stamp);
  let copied = false;
  for (const i of incoming) {
    const existing = path.join(workdir, i.to);
    let cur: Buffer;
    try {
      cur = await readFile(existing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (cur.equals(i.data)) continue;
    const dest = path.join(dir, i.to);
    await mkdir(path.dirname(dest), { recursive: true });
    for (let n = 0; ; n++) {
      try {
        await copyFile(existing, n === 0 ? dest : `${dest}.${n}`, constants.COPYFILE_EXCL);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    copied = true;
  }
  return copied ? dir : undefined;
}

export function resyncStamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}
