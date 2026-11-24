import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NAME_PATTERN } from "@open-factory/shared";
import { type LibraryIndex, skillProblem } from "../library/library-index.ts";
import { SafeFs, UnsafePathError, WorkspaceError } from "./safe-fs.ts";

export { WorkspaceError };

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the listed Library skills to their recorded real folders (spec §6.4). A name that doesn't resolve fails the
 * start with §6.6's message for the reason; the fix is `config`, which the caller re-points at the template when the
 * template lists it.
 */
export async function resolveSkills(
  lib: Pick<LibraryIndex, "resolveSkill">,
  names: string[],
): Promise<{ name: string; dir: string }[]> {
  const out: { name: string; dir: string }[] = [];
  for (const name of names) {
    const r = await lib.resolveSkill(name);
    if (!r.ok) {
      const diagnosis = skillProblem(name, r);
      throw new WorkspaceError(`${diagnosis} Fix it in Configuration.`, "config", diagnosis);
    }
    out.push({ name, dir: r.dir });
  }
  return out;
}

/** The template's own `skills/` folders (spec §6.4). Each entry must be a real folder and `skills/`
 *  must be one too; a link is a template error and nothing here ever follows it. `realDir` is
 *  `realpath(<template>/skills)/<name>`: the template folder itself may be a link (Docker mounts only
 *  real paths), but nothing inside it may be. Hidden entries are ignored, like template validation. */
export async function resolveTemplateSkills(
  templateDir: string,
): Promise<{ name: string; realDir: string }[]> {
  const root = path.join(templateDir, "skills");
  const top = await lstat(root).catch(() => undefined);
  if (!top) return [];
  if (!top.isDirectory())
    throw new WorkspaceError("skills/ must be a folder, not a link.", "template");
  const realRoot = await realpath(root);
  const out: { name: string; realDir: string }[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith(".")) continue;
    const st = await lstat(path.join(root, name));
    if (!st.isDirectory())
      throw new WorkspaceError(`skills/${name} must be a folder, not a link.`, "template");
    out.push({ name, realDir: path.join(realRoot, name) });
  }
  return out;
}

/** Make `<workdir>/<parentRel>/<name>` a symlink to each wanted target, refusing to touch
 *  non-links, then drop links in that folder that aren't wanted (and, when `onlyUnder` is set,
 *  point under one of those prefixes). Every step goes through `SafeFs`: a symlinked folder on the way fails. */
async function syncLinks(
  workdir: string,
  parentRel: string,
  wanted: { name: string; target: string; notLinkMessage: string }[],
  opts: { checkOnly?: boolean; onlyUnder?: string[] },
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
    if (opts.onlyUnder) {
      const to = await readlink(path.join(parent, name));
      if (
        !opts.onlyUnder.some(
          (u) => to === path.resolve(u) || to.startsWith(path.resolve(u) + path.sep),
        )
      )
        continue;
    }
    if (write) await safe.removeLink(rel);
  }
}

/** Links the Library skills and the template's own skills into `.claude/skills/` (spec §6.4). One sync covers every
 *  prefix (`prefixes` from `LibraryIndex.linkPrefixes`, plus the template's `skills/`), so a removed skill's link goes
 *  while the agent's own real folders stay. Links point at the real folder. */
export async function linkSkills(
  workdir: string,
  library: { name: string; dir: string }[],
  template: { templateDir: string; skills: { name: string; realDir: string }[] },
  opts: { checkOnly?: boolean; prefixes: string[] },
): Promise<void> {
  const parentRel = path.join(".claude", "skills");
  const parent = path.join(workdir, parentRel);
  // One link per name: a template skill would silently replace the Library skill the config lists.
  const libraryNames = new Set(library.map((s) => s.name));
  const clash = template.skills.find((s) => libraryNames.has(s.name));
  if (clash) {
    const diagnosis = `Skill ${clash.name} is both a Library skill and a template skill.`;
    throw new WorkspaceError(`${diagnosis} Fix it in Configuration.`, "config", diagnosis);
  }
  let realTemplate: string;
  try {
    realTemplate = await realpath(template.templateDir);
  } catch {
    // Gone since the config was resolved (spec §6.1's message, not a raw ENOENT).
    throw new WorkspaceError(`Template ${path.basename(template.templateDir)} no longer exists.`);
  }
  await syncLinks(
    workdir,
    parentRel,
    [
      ...library.map((s) => ({
        name: s.name,
        target: s.dir,
        notLinkMessage: `${path.join(parent, s.name)} isn't a link to the skill; move it away.`,
      })),
      ...template.skills.map((s) => ({
        name: s.name,
        target: s.realDir,
        notLinkMessage: `${path.join(parent, s.name)} isn't a link to the template skill; move it away.`,
      })),
    ],
    {
      ...(opts.checkOnly ? { checkOnly: true } : {}),
      onlyUnder: [...opts.prefixes, path.join(realTemplate, "skills")],
    },
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
