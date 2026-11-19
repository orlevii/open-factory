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
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, data);
  await rename(tmp, file);
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

export async function copyTargets(
  _tplDir: string,
  workdir: string,
  targets: { from: string; to: string }[],
  tplSettings: Record<string, unknown>,
  tplMcp: unknown,
): Promise<void> {
  for (const t of targets) {
    const dest = path.join(workdir, t.to);
    await mkdir(path.dirname(dest), { recursive: true });
    const st = await lstat(t.from);
    if (st.isSymbolicLink()) {
      await rm(dest, { force: true });
      await symlink(await readlink(t.from), dest);
    } else {
      await copyFile(t.from, dest);
      await chmod(dest, (await stat(t.from)).mode & 0o7777);
    }
  }
  await writeAtomic(
    path.join(workdir, ".factory/template/settings.json"),
    JSON.stringify(tplSettings, null, 2),
  );
  await writeAtomic(
    path.join(workdir, ".factory/template/mcp.json"),
    JSON.stringify(tplMcp, null, 2),
  );
}

export async function backupDiffering(
  workdir: string,
  incoming: { to: string; data: Buffer }[],
  stamp: string,
): Promise<string | undefined> {
  const rel = path.join(".factory", "resync", stamp);
  let copied = false;
  for (const i of incoming) {
    const existing = path.join(workdir, i.to);
    let cur: Buffer;
    try {
      cur = await readFile(existing);
    } catch {
      continue;
    }
    if (cur.equals(i.data)) continue;
    const dest = path.join(workdir, rel, i.to);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(existing, dest);
    copied = true;
  }
  return copied ? rel : undefined;
}

export function resyncStamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}
