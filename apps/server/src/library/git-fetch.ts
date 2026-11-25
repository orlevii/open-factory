/**
 * Pinned GitHub fetch into a read-only cache (spec §6.2, §6.3). Everything git runs through the
 * hardened `runGit`; the only bound on the download itself is the 180 s operation budget.
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { checkBranchName } from "@open-factory/shared";
import { CHECKOUT_MAX_ENTRIES, COMMIT_PATTERN as SHA } from "./common.ts";
import { GitError, runGit } from "./git.ts";

const OPERATION_BUDGET_MS = 180_000;

export interface GitFetchOptions {
  allowFile: boolean;
  signal?: AbortSignal;
  gitBin?: string;
  /** Names the repo in messages, such as `acme/x`. Defaults to the url. */
  label?: string;
  /** The per-operation time budget; tests shorten it. */
  budgetMs?: number;
}

export function repoUrl(base: string, r: { owner: string; repo: string }): string {
  return `${base}/${r.owner}/${r.repo}.git`;
}

/** Joins repo-relative parts with no leading slash; an empty part is skipped. */
export function joinRepoPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/** Runs `fn` with one signal that covers the whole operation: its time budget and the caller's. */
async function withBudget<T>(o: GitFetchOptions, fn: (git: GitCall) => Promise<T>): Promise<T> {
  const budgetMs = o.budgetMs ?? OPERATION_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const signal = o.signal ? AbortSignal.any([budget, o.signal]) : budget;
  const start = Date.now();
  // The per-command default (60 s) must not cut a legal download short: the budget is the bound.
  const git: GitCall = (args, cwd) =>
    runGit(args, {
      cwd,
      allowFile: o.allowFile,
      gitBin: o.gitBin,
      signal,
      timeoutMs: Math.max(1, budgetMs - (Date.now() - start)),
    });
  try {
    return await fn(git);
  } catch (e) {
    if (budget.aborted && !o.signal?.aborted && e instanceof GitError) {
      throw new GitError(`git timed out after ${budgetMs / 1000} s.`, e.output);
    }
    throw e;
  }
}

type GitCall = (args: string[], cwd?: string) => Promise<{ stdout: string }>;

/** `ls-remote` tail-matches patterns, so only a line whose ref equals the requested one counts. */
export async function resolveRef(
  url: string,
  branch: string | null,
  o: GitFetchOptions,
): Promise<{ sha: string; branch: string }> {
  return withBudget(o, async (git) => {
    const label = o.label ?? url;
    if (branch === null) {
      const { stdout } = await git(["ls-remote", "--symref", url, "HEAD"]);
      let name: string | undefined;
      let sha: string | undefined;
      for (const line of stdout.split("\n")) {
        const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
        if (sym) name = sym[1];
        const m = /^([0-9a-f]+)\tHEAD$/.exec(line);
        if (m) sha = m[1];
      }
      if (!name || !checkBranchName(name) || !sha || !SHA.test(sha))
        throw new GitError(`${label} has no default branch.`, "");
      return { sha, branch: name };
    }
    const ref = `refs/heads/${branch}`;
    const { stdout } = await git(["ls-remote", url, ref]);
    for (const line of stdout.split("\n")) {
      const [sha, name] = line.split("\t");
      if (name === ref && sha && SHA.test(sha)) return { sha, branch };
    }
    throw new GitError(`No branch ${branch} in ${label}.`, "");
  });
}

/** The fetched HEAD is not the commit asked for (spec §10.4's form-level "another commit"). */
export class CommitMismatchError extends GitError {
  constructor(message: string) {
    super(message, "");
    this.name = "CommitMismatchError";
  }
}

/** Fetches one commit into `into` (made if missing) and checks it out, failing closed on a mismatch. */
export async function fetchCommit(
  url: string,
  sha: string,
  into: string,
  o: GitFetchOptions,
): Promise<{ committedAt: string; subject: string }> {
  if (!SHA.test(sha)) throw new GitError("git failed: invalid commit.", "");
  return withBudget(o, async (git) => {
    await mkdir(into, { recursive: true });
    await git(["init", "-q"], into);
    await git(["fetch", "--depth", "1", "--no-tags", url, sha], into);
    await git(["checkout", "-q", "--detach", "FETCH_HEAD"], into);
    const head = (await git(["rev-parse", "HEAD"], into)).stdout.trim();
    if (head !== sha) {
      throw new CommitMismatchError(`${o.label ?? url} didn't return commit ${sha.slice(0, 7)}.`);
    }
    const [committedAt = "", subject = ""] = (
      await git(["log", "-1", "--format=%cI%x00%s"], into)
    ).stdout
      .replace(/\n$/, "")
      .split("\0");
    return { committedAt, subject };
  });
}

/**
 * Tree sha of each repo-relative path at `sha` (`<sha>:<path>`, no leading slash), all within one operation budget.
 * Fails closed: an answer that isn't a full object id is an error, never a recorded pin.
 */
export async function treeShas(
  co: string,
  sha: string,
  paths: string[],
  o: Pick<GitFetchOptions, "signal" | "gitBin" | "budgetMs"> = {},
): Promise<Record<string, string>> {
  if (!SHA.test(sha)) throw new GitError("git failed: invalid commit.", "");
  return withBudget({ allowFile: false, ...o }, async (git) => {
    const out: Record<string, string> = {};
    for (const p of paths) {
      const tree = (await git(["rev-parse", `${sha}:${p}`], co)).stdout.trim();
      if (!SHA.test(tree)) throw new GitError(`git returned no tree for ${p}.`, "");
      out[p] = tree;
    }
    return out;
  });
}

/**
 * Bytes of regular files under `dir`, without following links and without `.git`. Throws `over_cap` past `capBytes`
 * or past `maxEntries` files and folders (a tree of countless tiny files is as unreasonable as a big one).
 */
export async function checkoutSize(
  dir: string,
  capBytes: number,
  maxEntries = CHECKOUT_MAX_ENTRIES,
): Promise<number> {
  let total = 0;
  let entries = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === ".git" && d === dir) continue;
      if (++entries > maxEntries) throw new Error("over_cap");
      const p = path.join(d, e.name);
      const st = await lstat(p);
      if (st.isDirectory()) await walk(p);
      else {
        total += st.size;
        if (total > capBytes) throw new Error("over_cap");
      }
    }
  };
  await walk(dir);
  return total;
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/**
 * Copies the subtree at `subpath` (no `.git`) to `dest` through a temp name and a rename, read-only:
 * dirs 0555, files 0444, executables 0555. The subpath must stay inside `co`, lexically and by realpath,
 * and may not name `.git`. Not idempotent: an existing non-empty `dest` fails, so callers check for a
 * cache hit first.
 */
export async function installCheckout(co: string, subpath: string, dest: string): Promise<void> {
  if (subpath.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".git")) {
    throw new Error("The path must stay inside the repository.");
  }
  const root = path.resolve(co);
  const src = path.resolve(root, subpath);
  if (path.isAbsolute(subpath) || !inside(root, src)) {
    throw new Error("The path must stay inside the repository.");
  }
  const realRoot = await realpath(root);
  const realSrc = await realpath(src);
  if (!inside(realRoot, realSrc)) throw new Error("The path must stay inside the repository.");
  if (!(await lstat(realSrc)).isDirectory()) throw new Error("The path must be a folder.");

  await mkdir(path.dirname(dest), { recursive: true });
  // Shares dest's parent, which is what lets a 0555 dir be renamed (only a parent change needs write).
  const tmp = `${dest}.tmp-${randomUUID()}`;
  const copy = async (from: string, to: string): Promise<void> => {
    await mkdir(to);
    for (const e of await readdir(from, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = path.join(from, e.name);
      const t = path.join(to, e.name);
      if (e.isDirectory()) await copy(f, t);
      else if (e.isFile()) {
        const st = await lstat(f);
        await copyFile(f, t);
        await chmod(t, st.mode & 0o111 ? 0o555 : 0o444);
      } else throw new Error(`${path.relative(realSrc, f)} is not a file or folder.`);
    }
    await chmod(to, 0o555);
  };
  try {
    await copy(realSrc, tmp);
    await rename(tmp, dest);
  } catch (e) {
    // A failed copy may leave 0555 dirs a plain rm can't empty.
    await removeTree(tmp).catch(() => {});
    throw e;
  }
}

/** Removes a tree `installCheckout` made read-only (0555 dirs a plain `rm` can't empty). Missing is fine. */
export async function removeTree(dir: string): Promise<void> {
  await makeWritable(dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await makeWritable(path.join(dir, e.name));
  }
}
