import { randomUUID } from "node:crypto";
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
import { SafeFs, WorkspaceError } from "./safe-fs.ts";

/** Atomic write for factory-owned paths outside agent workdirs (`FACTORY_HOME/state`). Anything
 *  under a workdir goes through `SafeFs` instead. */
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

export async function templateTargets(tplDir: string): Promise<{ from: string; to: string }[]> {
  const out: { from: string; to: string }[] = [];
  const agents = path.join(tplDir, "AGENTS.md");
  if (
    await lstat(agents).then(
      () => true,
      () => false,
    )
  )
    out.push({ from: agents, to: "AGENTS.md" });
  for (const r of await walk(path.join(tplDir, "files"))) {
    out.push({ from: path.join(tplDir, "files", r), to: r });
  }
  return out;
}

export async function copyTargets(
  _tplDir: string,
  workdir: string,
  templateCopy: string,
  targets: { from: string; to: string }[],
  tplSettings: Record<string, unknown>,
  tplMcp: unknown,
): Promise<void> {
  await writeTargets(workdir, targets);
  await writeTemplateCopy(templateCopy, tplSettings, tplMcp);
}

/** Writes targets into the workdir through `SafeFs`. A source symlink stays a link. */
export async function writeTargets(
  workdir: string,
  targets: { from: string; to: string }[],
): Promise<void> {
  const safe = new SafeFs(workdir);
  for (const t of targets) {
    // The source is factory-owned or the human's template dir (trusted); only the workdir side is guarded.
    const st = await lstat(t.from);
    if (st.isSymbolicLink()) await safe.link(t.to, await readlink(t.from));
    else await safe.writeFile(t.to, await readFile(t.from), st.mode & 0o777);
  }
}

export async function writeTemplateCopy(
  templateCopy: string,
  tplSettings: Record<string, unknown>,
  tplMcp: unknown,
): Promise<void> {
  await writeAtomic(path.join(templateCopy, "settings.json"), JSON.stringify(tplSettings, null, 2));
  await writeAtomic(path.join(templateCopy, "mcp.json"), JSON.stringify(tplMcp, null, 2));
}

/** Replaces `pendingDir` with a copy of the targets (latest wins), built aside and renamed in so
 *  a crash never leaves a half-staged dir. Links stay links. `pendingDir` is factory state. */
export async function stageTargets(
  pendingDir: string,
  targets: { from: string; to: string }[],
): Promise<void> {
  const tmp = `${pendingDir}.tmp-${randomUUID()}`;
  try {
    await mkdir(tmp, { recursive: true });
    for (const t of targets) {
      const dest = path.join(tmp, t.to);
      await mkdir(path.dirname(dest), { recursive: true });
      const st = await lstat(t.from);
      if (st.isSymbolicLink()) await symlink(await readlink(t.from), dest);
      else {
        await copyFile(t.from, dest);
        await chmod(dest, st.mode & 0o777);
      }
    }
    await rm(pendingDir, { recursive: true, force: true });
    await rename(tmp, pendingDir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Copies the workdir files an incoming template would change into `<backupRoot>/<stamp>/`.
 *  A symlink is backed up as a symlink, never its target's bytes. Returns that absolute dir, or
 *  undefined when nothing differed. */
export async function backupDiffering(
  workdir: string,
  backupRoot: string,
  incoming: { to: string; data: Buffer }[],
  stamp: string,
): Promise<string | undefined> {
  const safe = new SafeFs(workdir);
  const dir = path.join(backupRoot, stamp);
  let copied = false;
  for (const i of incoming) {
    const st = await safe.entry(i.to);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      // The incoming side of a link is its link text (see `applyTargets`): an unchanged link needs no backup.
      const cur = Buffer.from(`\0symlink:${await readlink(path.join(workdir, i.to))}`);
      if (cur.equals(i.data)) continue;
    } else {
      const cur = await safe.readIfRegular(i.to);
      if (!cur) throw new WorkspaceError(`${path.join(workdir, i.to)} isn't a file; move it away.`);
      if (cur.equals(i.data)) continue;
    }
    const dest = path.join(dir, i.to);
    await mkdir(path.dirname(dest), { recursive: true });
    for (let n = 0; ; n++) {
      try {
        await safe.copyOut(i.to, n === 0 ? dest : `${dest}.${n}`);
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
