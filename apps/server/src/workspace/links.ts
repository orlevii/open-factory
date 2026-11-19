import { readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { HOST_SKILL_PATTERN, NAME_PATTERN } from "@open-factory/shared";
import { SafeFs, UnsafePathError, WorkspaceError } from "./safe-fs.ts";

export { WorkspaceError };

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
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

/** Make `<workdir>/<parentRel>/<name>` a symlink to each wanted target, refusing to touch
 *  non-links, then drop links in that folder that aren't wanted (and, when `onlyUnder` is set,
 *  point under that prefix). Every step goes through `SafeFs`: a symlinked folder on the way fails. */
async function syncLinks(
  workdir: string,
  parentRel: string,
  wanted: { name: string; target: string; notLinkMessage: string }[],
  opts: { checkOnly?: boolean; onlyUnder?: string },
): Promise<void> {
  const safe = new SafeFs(workdir);
  const write = !opts.checkOnly;
  const parent = path.join(workdir, parentRel);
  if (write) await safe.mkdirp(parentRel);
  else {
    const pst = await safe.entry(parentRel);
    if (pst?.isSymbolicLink()) throw new UnsafePathError(parent);
    if (pst && !pst.isDirectory())
      throw new WorkspaceError(`${parent} isn't a folder; move it away.`);
  }
  for (const w of wanted) {
    const rel = path.join(parentRel, w.name);
    const st = await safe.entry(rel);
    if (st && !st.isSymbolicLink()) throw new WorkspaceError(w.notLinkMessage);
    if (write) await safe.link(rel, w.target);
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
    const rel = path.join(parentRel, name);
    const st = await safe.entry(rel);
    if (!st?.isSymbolicLink()) continue;
    if (
      opts.onlyUnder &&
      !(await readlink(path.join(parent, name))).startsWith(path.resolve(opts.onlyUnder) + path.sep)
    )
      continue;
    if (write) await safe.removeLink(rel);
  }
}

export async function linkHostSkills(
  workdir: string,
  hostSkillsDir: string,
  skills: { name: string; dir: string }[],
  opts?: { checkOnly?: boolean },
): Promise<void> {
  const parentRel = path.join(".claude", "skills");
  const parent = path.join(workdir, parentRel);
  await syncLinks(
    workdir,
    parentRel,
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
    if (!NAME_PATTERN.test(g.name))
      throw new WorkspaceError(`${g.name} isn't a valid project name.`, "projects");
    if (!(await isDir(g.hostPath))) {
      throw new WorkspaceError(`Project ${g.name}'s folder ${g.hostPath} is missing.`, "projects");
    }
  }
  const parent = path.join(workdir, "projects");
  await syncLinks(
    workdir,
    "projects",
    grants.map((g) => ({
      name: g.name,
      target: g.hostPath,
      notLinkMessage: `${path.join(parent, g.name)} isn't a link to the project folder; move it away.`,
    })),
    { ...opts },
  );
}
