import { lstat, mkdir, readdir, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { HOST_SKILL_PATTERN } from "@open-factory/shared";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly fix?: "projects" | "edit_agent",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

export async function resolveHostSkills(
  hostSkillsDir: string,
  names: string[],
): Promise<{ name: string; dir: string; realDir: string }[]> {
  const out: { name: string; dir: string; realDir: string }[] = [];
  for (const name of names) {
    const dir = path.join(hostSkillsDir, name);
    if (!HOST_SKILL_PATTERN.test(name) || !(await isDir(dir))) {
      throw new WorkspaceError(
        `Host skill ${name} is missing from ${hostSkillsDir}.`,
        "edit_agent",
      );
    }
    out.push({ name, dir, realDir: await realpath(dir) });
  }
  return out;
}

/** Make `<parent>/<name>` a symlink to each wanted target, refusing to touch non-links, then drop
 *  links in `parent` that aren't wanted (and, when `onlyUnder` is set, point under that prefix). */
async function syncLinks(
  parent: string,
  wanted: { name: string; target: string; notLinkMessage: string }[],
  opts: { checkOnly?: boolean; onlyUnder?: string },
): Promise<void> {
  const write = !opts.checkOnly;
  if (write) await mkdir(parent, { recursive: true });
  for (const w of wanted) {
    const entry = path.join(parent, w.name);
    const st = await lstatOrNull(entry);
    if (st && !st.isSymbolicLink()) throw new WorkspaceError(w.notLinkMessage);
    if (!write) continue;
    if (st) await unlink(entry);
    await symlink(w.target, entry);
  }
  let existing: string[] = [];
  try {
    existing = await readdir(parent);
  } catch {
    return;
  }
  const keep = new Set(wanted.map((w) => w.name));
  for (const name of existing) {
    if (keep.has(name)) continue;
    const entry = path.join(parent, name);
    const st = await lstatOrNull(entry);
    if (!st?.isSymbolicLink()) continue;
    if (opts.onlyUnder && !(await readlink(entry)).startsWith(opts.onlyUnder + path.sep)) continue;
    if (write) await unlink(entry);
  }
}

export async function linkHostSkills(
  workdir: string,
  hostSkillsDir: string,
  skills: { name: string; dir: string }[],
  opts?: { checkOnly?: boolean },
): Promise<void> {
  const parent = path.join(workdir, ".claude", "skills");
  await syncLinks(
    parent,
    skills.map((s) => ({
      name: s.name,
      target: s.dir,
      notLinkMessage: `${path.join(parent, s.name)} isn't a link to the host skill; move it away.`,
    })),
    { ...opts, onlyUnder: hostSkillsDir },
  );
}

export async function linkProjects(
  workdir: string,
  grants: { name: string; hostPath: string }[],
  opts?: { checkOnly?: boolean },
): Promise<void> {
  for (const g of grants) {
    if (!(await isDir(g.hostPath))) {
      throw new WorkspaceError(`Project ${g.name}'s folder ${g.hostPath} is missing.`, "projects");
    }
  }
  const parent = path.join(workdir, "projects");
  await syncLinks(
    parent,
    grants.map((g) => ({
      name: g.name,
      target: g.hostPath,
      notLinkMessage: `${path.join(parent, g.name)} isn't a link to the project folder; move it away.`,
    })),
    { ...opts },
  );
}
