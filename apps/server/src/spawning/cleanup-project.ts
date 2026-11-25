import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { type ProjectResult, slugSchema } from "@open-factory/shared";
import { SafeFs } from "../workspace/safe-fs";
import { GitError, git } from "./git";

// Spec §7.5. SECURITY BOUNDARY: this deletes folders and branches in repos agents can write.
// Paths and ids that git or the agent wrote are data, used only to match; the only things
// removed are the computed `base` and `<common>/worktrees/<id>` for ids that passed every check.

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code ?? "error";

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

function assertSlug(slug: string): void {
  if (
    !slugSchema.safeParse(slug).success ||
    slug === "." ||
    slug === ".." ||
    slug.includes("/") ||
    slug.includes("\\") ||
    path.basename(slug) !== slug
  )
    throw new Error("invalid slug");
}

type Entry = { path: string; branch?: string };

function parseWorktrees(out: string): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | undefined;
  for (const field of out.split("\0")) {
    if (field === "") {
      cur = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      cur = { path: field.slice("worktree ".length) };
      entries.push(cur);
    } else if (cur && field.startsWith("branch refs/heads/")) {
      cur.branch = field.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

const inside = (base: string, p: string): boolean => {
  if (!path.isAbsolute(p)) return false;
  const rel = path.relative(base, path.normalize(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** A real directory (not a symlink); false when it is anything else. */
async function isRealDir(p: string): Promise<boolean> {
  const st = await lstatOrNull(p);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

const fail = (
  project: string,
  error: string,
  extra: Partial<ProjectResult> = {},
): ProjectResult => ({
  project,
  removed: false,
  deleted: [],
  kept: [],
  ...extra,
  error,
});

/** null = nothing of ours there. A GitMissingError propagates (the caller reports it once for the host). */
export async function cleanupProject(
  p: { name: string; hostPath: string },
  slug: string,
): Promise<ProjectResult | null> {
  assertSlug(slug);
  const name = p.name;
  const rel = `.worktrees/.agents/${slug}`;

  // 1. the repository
  let repo: string;
  try {
    repo = await realpath(p.hostPath);
  } catch (err) {
    if (missing(err)) return fail(name, "the project folder is missing");
    throw err;
  }
  let common: string;
  try {
    const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
    if (top !== repo) return fail(name, "not a git repository");
    common = await realpath(
      path.resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()),
    );
  } catch (err) {
    if (err instanceof GitError) return fail(name, "not a git repository");
    if (missing(err)) return fail(name, "the project folder is missing");
    throw err;
  }

  // 2. our folder
  const wtDir = path.join(repo, ".worktrees");
  const agentsDir = path.join(wtDir, ".agents");
  const base = path.join(agentsDir, slug);
  let baseExists = true;
  for (const [dir, label] of [
    [wtDir, ".worktrees"],
    [agentsDir, ".worktrees/.agents"],
    [base, rel],
  ] as const) {
    const st = await lstatOrNull(dir);
    if (!st) {
      baseExists = false;
      break;
    }
    if (st.isSymbolicLink()) return fail(name, `${label} is a symbolic link; left in place`);
    if (!st.isDirectory()) return fail(name, `${label} is not a folder; left in place`);
  }

  // 3. entries
  const entries = parseWorktrees(await git(repo, ["worktree", "list", "--porcelain", "-z"]));
  const ours = entries.filter((e) => inside(base, e.path));
  const branches = ours.flatMap((e) => (e.branch ? [e.branch] : []));
  const checkedOutElsewhere = new Set(
    entries.flatMap((e, i) => ((!inside(base, e.path) || i === 0) && e.branch ? [e.branch] : [])),
  );

  // 4. admin dirs
  const wt = path.join(common, "worktrees");
  const adminDirs: { dir: string; worktree: string }[] = [];
  let wtReal: string | undefined;
  const wtSt = await lstatOrNull(wt);
  if (wtSt) {
    if (wtSt.isSymbolicLink() || !wtSt.isDirectory())
      return fail(name, "the repository's worktrees folder is not a plain folder; left in place");
    wtReal = await realpath(wt);
    for (const id of await readdir(wt)) {
      if (!/^[^./][^/]*$/.test(id) || id.includes("..")) continue;
      const dir = path.join(wt, id);
      if (!(await isRealDir(dir))) continue;
      if (path.dirname(await realpath(dir)) !== wtReal) continue;
      const raw = (await new SafeFs(dir).readIfRegular("gitdir"))?.toString("utf8").trim();
      if (!raw) continue;
      const g = path.normalize(path.isAbsolute(raw) ? raw : path.resolve(wt, id, raw));
      if (inside(base, path.dirname(g))) adminDirs.push({ dir, worktree: path.dirname(g) });
    }
  }
  for (const e of ours) {
    const worktree = path.normalize(e.path);
    if (!adminDirs.some((a) => a.worktree === worktree))
      return fail(name, `couldn't match ${e.branch ?? worktree}'s metadata; left in place`);
  }

  if (!baseExists && ours.length === 0 && adminDirs.length === 0) return null;

  const result: ProjectResult = { project: name, removed: false, deleted: [], kept: [] };

  // 5. our folder
  if (baseExists) {
    try {
      const st = await lstat(base);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("changed");
      if ((await realpath(base)) !== path.join(repo, ".worktrees/.agents", slug))
        throw new Error("changed");
      await new SafeFs(base).removeAll();
    } catch (err) {
      return {
        ...result,
        error: `couldn't remove ${rel}: ${(err as Error).message === "changed" ? "changed while cleaning up" : codeOf(err)}`,
      };
    }
    result.removed = true;
  }

  // 6. our metadata (never `git worktree prune`)
  if (wtReal) {
    for (const { dir } of adminDirs) {
      try {
        if (!(await isRealDir(dir)) || path.dirname(await realpath(dir)) !== wtReal)
          throw new Error("changed");
        await new SafeFs(dir).removeAll();
      } catch (err) {
        return {
          ...result,
          error: `couldn't remove git's record of ${rel}: ${(err as Error).message === "changed" ? "changed while cleaning up" : codeOf(err)}`,
        };
      }
    }
  }

  // 7. branches
  const d = await git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).then(
    (s) => s.trim().replace(/^refs\/remotes\/origin\//, ""),
    () => undefined,
  );
  let def: string | undefined;
  for (const c of [d, "main", "master"]) {
    if (!c) continue;
    const exists = await git(repo, ["show-ref", "--verify", "-q", `refs/heads/${c}`]).then(
      () => true,
      () => false,
    );
    if (exists) {
      def = c;
      break;
    }
  }
  const protectedNames = new Set([d, "main", "master"].filter((x): x is string => !!x));
  for (const branch of branches) {
    const valid = await git(repo, ["check-ref-format", "--branch", branch]).then(
      () => true,
      () => false,
    );
    if (!valid || protectedNames.has(branch)) continue;
    if (checkedOutElsewhere.has(branch)) {
      result.kept.push({ branch, reason: "elsewhere" });
      continue;
    }
    try {
      const n = Number(
        await git(repo, [
          "rev-list",
          "--count",
          `refs/heads/${branch}`,
          "--not",
          "--remotes",
          ...(def ? [`refs/heads/${def}`] : []),
          "--",
        ]),
      );
      if (n === 0) {
        await git(repo, ["branch", "-D", "--end-of-options", branch]);
        result.deleted.push(branch);
      } else result.kept.push({ branch, commits: n });
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      result.error ??= `couldn't check ${branch}; left in place`;
    }
  }
  return result;
}
