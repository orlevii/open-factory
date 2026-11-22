import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { SafeFs, WorkspaceError } from "../workspace/safe-fs.ts";

const LINE = ".factory/";
const PRESENT = new Set([".factory", ".factory/", "/.factory", "/.factory/"]);
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

export type ExcludeOutcome = "added" | "present" | "no_repo" | "refused";

const inside = (root: string, p: string) => {
  const r = path.relative(root, p);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

/**
 * U3 §13.5: keeps `.factory/` out of the agent's repository by appending it to `info/exclude` (never a tracked
 * `.gitignore`), idempotently and append-only. Only a repository rooted at the workdir counts. A worktree's `.git` file
 * points at its git dir, whose `commondir` names the shared one: that common dir's `info/exclude` is written, so every
 * worktree shares the line. Everything on the way is agent-writable, so the git dir must lie inside one of
 * `allowedRoots` (the workdir and the agent's granted projects), every component is `lstat`ed from that root (a link
 * anywhere is "refused") and the file is opened with `O_NOFOLLOW`.
 */
export async function excludeFactoryDir(
  workdir: string,
  allowedRoots: string[],
): Promise<ExcludeOutcome> {
  const roots: string[] = [];
  for (const r of allowedRoots) {
    const real = await realpath(r).catch(() => undefined);
    if (real) roots.push(real);
  }
  const rootOf = (p: string) => roots.find((r) => inside(r, p));
  try {
    const wfs = new SafeFs(workdir);
    const dotGit = await wfs.entry(".git");
    if (!dotGit) return "no_repo";
    let gitDir: string;
    if (dotGit.isDirectory()) gitDir = path.join(workdir, ".git");
    else if (dotGit.isFile()) {
      const text = (await wfs.readIfRegular(".git"))?.toString("utf8") ?? "";
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m?.[1]) return "refused";
      gitDir = path.resolve(workdir, m[1]);
    } else return "refused";

    const gitRoot = rootOf(gitDir);
    if (!gitRoot) return "refused";
    const commondir = await new SafeFs(gitRoot).readIfRegular(
      path.relative(gitRoot, path.join(gitDir, "commondir")),
    );
    const common = commondir ? path.resolve(gitDir, commondir.toString("utf8").trim()) : gitDir;
    const root = rootOf(common);
    if (!root) return "refused";
    const fs = new SafeFs(root);
    const rel = path.relative(root, path.join(common, "info", "exclude"));

    let existing = "";
    const st = await fs.entry(rel);
    if (st) {
      if (!st.isFile()) return "refused";
      const data = await fs.readIfRegular(rel);
      if (data === undefined) return "refused";
      existing = data.toString("utf8");
      if (existing.split(/\r?\n/).some((l) => PRESENT.has(l.trim()))) return "present";
    } else {
      await fs.mkdirp(path.dirname(rel));
      await fs.assertParents(rel);
    }
    const fh = await open(path.join(root, rel), APPEND_FLAGS, 0o644);
    try {
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      await fh.appendFile(`${sep}${LINE}\n`);
    } finally {
      await fh.close();
    }
    return "added";
  } catch (err) {
    if (err instanceof WorkspaceError) return "refused";
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") return "refused";
    throw err;
  }
}
