import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupProject } from "./cleanup-project";

let root: string;
let repo: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
const commit = (cwd: string, msg: string) => g(cwd, "commit", "-q", "--allow-empty", "-m", msg);
const gitVersion = (): [number, number] => {
  const m = /(\d+)\.(\d+)/.exec(g(root, "--version"));
  return [Number(m?.[1]), Number(m?.[2])];
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "of-cleanup-")));
  const origin = path.join(root, "origin.git");
  mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  commit(repo, "init");
  g(repo, "remote", "add", "origin", origin);
  g(repo, "push", "-q", "origin", "main");
  g(repo, "remote", "set-head", "origin", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const project = () => ({ name: "web", hostPath: repo });
const ours = (slug: string, branch: string) => path.join(repo, ".worktrees/.agents", slug, branch);
function addWorktree(
  slug: string,
  branch: string,
  opts: { commits?: number; push?: boolean } = {},
) {
  const dir = ours(slug, branch);
  g(repo, "worktree", "add", "-q", "-b", branch, dir);
  for (let i = 0; i < (opts.commits ?? 1); i++) commit(dir, `${branch} ${i}`);
  if (opts.push) g(repo, "push", "-q", "origin", branch);
  return dir;
}
const worktreeLines = () =>
  g(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "));
const adminIds = () => readdirSync(path.join(repo, ".git/worktrees")).sort();
const branchExists = (b: string) => {
  try {
    g(repo, "show-ref", "--verify", "-q", `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};

describe("cleanupProject", () => {
  it.each(["..", "a/b", ".agents", ""])("refuses the slug %j and touches nothing", async (slug) => {
    addWorktree("dev-ab12", "feat/x");
    const before = [
      g(repo, "worktree", "list", "--porcelain"),
      g(repo, "show-ref"),
      adminIds().join(),
    ];
    await expect(cleanupProject(project(), slug)).rejects.toThrow("invalid slug");
    expect([
      g(repo, "worktree", "list", "--porcelain"),
      g(repo, "show-ref"),
      adminIds().join(),
    ]).toEqual(before);
    expect(existsSync(ours("dev-ab12", "feat/x"))).toBe(true);
  });

  it("removes our folder and metadata, deletes the pushed branch, keeps the unpushed one", async () => {
    addWorktree("dev-ab12", "feat/x");
    addWorktree("dev-ab12", "fix/y", { push: true });
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r).toEqual({
      project: "web",
      removed: true,
      deleted: ["fix/y"],
      kept: [{ branch: "feat/x", commits: 1 }],
    });
    expect(existsSync(path.join(repo, ".worktrees/.agents/dev-ab12"))).toBe(false);
    expect(worktreeLines()).toEqual([`worktree ${repo}`]);
    expect(branchExists("fix/y")).toBe(false);
    expect(branchExists("feat/x")).toBe(true);
  });

  it("deletes a branch merged into main locally though never pushed", async () => {
    addWorktree("dev-ab12", "feat/m");
    g(repo, "merge", "-q", "--ff-only", "feat/m");
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r?.deleted).toEqual(["feat/m"]);
    expect(branchExists("feat/m")).toBe(false);
  });

  it("never prunes a human's worktree whose folder is gone, and leaves other agents alone", async () => {
    addWorktree("dev-ab12", "feat/x", { push: true });
    const human = path.join(repo, ".worktrees/feat-z");
    g(repo, "worktree", "add", "-q", "-b", "feat/z", human);
    renameSync(human, path.join(root, "moved"));
    const other = addWorktree("dev-zz99", "feat/o");
    await cleanupProject(project(), "dev-ab12");
    expect(adminIds()).toHaveLength(2);
    expect(existsSync(other)).toBe(true);
    expect(g(repo, "worktree", "list", "--porcelain")).toContain(human);
    expect(branchExists("feat/o")).toBe(true);
  });

  it("keeps a branch also checked out in the main checkout or another worktree (elsewhere)", async () => {
    g(repo, "branch", "feat/e");
    g(repo, "branch", "feat/h");
    g(repo, "checkout", "-q", "feat/e");
    g(repo, "worktree", "add", "-q", "--force", ours("dev-ab12", "feat/e"), "feat/e");
    g(repo, "worktree", "add", "-q", path.join(root, "human"), "feat/h");
    g(repo, "worktree", "add", "-q", "--force", ours("dev-ab12", "feat/h"), "feat/h");
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r?.kept).toEqual([
      { branch: "feat/e", reason: "elsewhere" },
      { branch: "feat/h", reason: "elsewhere" },
    ]);
    expect(r?.deleted).toEqual([]);
    expect(branchExists("feat/e") && branchExists("feat/h")).toBe(true);
  });

  it("never deletes main, master or origin's default even checked out in our folder", async () => {
    g(repo, "branch", "master");
    g(repo, "branch", "develop");
    g(repo, "push", "-q", "origin", "develop");
    g(repo, "remote", "set-head", "origin", "develop");
    g(repo, "checkout", "-q", "--detach");
    for (const b of ["main", "master", "develop"])
      g(repo, "worktree", "add", "-q", ours("dev-ab12", b), b);
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r).toMatchObject({ removed: true, deleted: [], kept: [] });
    for (const b of ["main", "master", "develop"]) expect(branchExists(b)).toBe(true);
  });

  it("removes a locked worktree and judges its branch normally", async () => {
    const dir = addWorktree("dev-ab12", "feat/l", { push: true });
    g(repo, "worktree", "lock", dir);
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r?.deleted).toEqual(["feat/l"]);
    expect(existsSync(dir)).toBe(false);
    expect(adminIds()).toEqual([]);
  });

  it("matches and removes a worktree created with --relative-paths", async (ctx) => {
    const [maj, min] = gitVersion();
    if (maj < 2 || (maj === 2 && min < 48)) return ctx.skip();
    const dir = ours("dev-ab12", "feat/r");
    g(repo, "worktree", "add", "-q", "--relative-paths", "-b", "feat/r", dir);
    commit(dir, "r");
    g(repo, "push", "-q", "origin", "feat/r");
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r).toMatchObject({ removed: true, deleted: ["feat/r"] });
    expect(adminIds()).toEqual([]);
  });

  it("copes with origin/HEAD naming a branch that has no local copy", async () => {
    addWorktree("dev-ab12", "feat/x", { commits: 2 });
    g(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r).toMatchObject({ removed: true, kept: [{ branch: "feat/x", commits: 2 }] });
    expect(r?.error).toBeUndefined();
  });

  it("removes leftover metadata when the agent already deleted its folder", async () => {
    const dir = addWorktree("dev-ab12", "feat/g", { push: true });
    rmSync(path.join(repo, ".worktrees"), { recursive: true });
    expect(existsSync(dir)).toBe(false);
    const r = await cleanupProject(project(), "dev-ab12");
    expect(r).toEqual({ project: "web", removed: false, deleted: ["feat/g"], kept: [] });
    expect(adminIds()).toEqual([]);
  });

  it("returns null when nothing of ours is there", async () => {
    addWorktree("dev-zz99", "feat/o");
    expect(await cleanupProject(project(), "dev-ab12")).toBeNull();
  });
});
