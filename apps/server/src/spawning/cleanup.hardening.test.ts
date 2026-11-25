import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupProject } from "./cleanup-project";

// Attacks on the cleanup of a repo an agent can write: every case has an outside `victim/`
// holding a file that must survive.

let root: string;
let repo: string;
let victim: string;
const SLUG = "dev-ab12";

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

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "of-harden-")));
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
  victim = path.join(root, "victim");
  mkdirSync(path.join(victim, ".agents", SLUG, "feat"), { recursive: true });
  mkdirSync(path.join(victim, SLUG), { recursive: true });
  writeFileSync(path.join(victim, "keep.txt"), "precious");
  writeFileSync(path.join(victim, ".agents", SLUG, "feat", "keep.txt"), "precious");
  writeFileSync(path.join(victim, SLUG, "keep.txt"), "precious");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const project = (hostPath = repo) => ({ name: "web", hostPath });
const base = () => path.join(repo, ".worktrees/.agents", SLUG);
const victimIntact = () =>
  ["keep.txt", `.agents/${SLUG}/feat/keep.txt`, `${SLUG}/keep.txt`].every(
    (f) => readFileSync(path.join(victim, f), "utf8") === "precious",
  );
function addWorktree(branch: string, opts: { commits?: number; push?: boolean } = {}) {
  const dir = path.join(base(), branch);
  g(repo, "worktree", "add", "-q", "-b", branch, dir);
  for (let i = 0; i < (opts.commits ?? 1); i++) commit(dir, `${branch} ${i}`);
  if (opts.push) g(repo, "push", "-q", "origin", branch);
  return dir;
}
const wtAdmin = () => path.join(repo, ".git/worktrees");
const adminIds = () => readdirSync(wtAdmin()).sort();

describe("symlinked components of our folder", () => {
  it("refuses a symlinked .worktrees", async () => {
    symlinkSync(victim, path.join(repo, ".worktrees"));
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/^\.worktrees is a symbolic link; left in place/);
    expect(r?.removed).toBe(false);
    expect(victimIntact()).toBe(true);
  });

  it("refuses a symlinked .worktrees/.agents", async () => {
    mkdirSync(path.join(repo, ".worktrees"));
    symlinkSync(victim, path.join(repo, ".worktrees/.agents"));
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/^\.worktrees\/\.agents is a symbolic link; left in place/);
    expect(victimIntact()).toBe(true);
  });

  it("refuses a symlinked <slug>", async () => {
    mkdirSync(path.join(repo, ".worktrees/.agents"), { recursive: true });
    symlinkSync(path.join(victim, SLUG), base());
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toBe(`.worktrees/.agents/${SLUG} is a symbolic link; left in place`);
    expect(r?.removed).toBe(false);
    expect(victimIntact()).toBe(true);
  });

  it("reports nothing for a regular file in place of a folder when nothing of ours is there", async () => {
    mkdirSync(path.join(repo, ".worktrees"));
    writeFileSync(path.join(repo, ".worktrees/.agents"), "x");
    expect(await cleanupProject(project(), SLUG)).toBeNull();
  });

  it.each([".worktrees", ".worktrees/.agents"])(
    "reports nothing for a symlinked %s that leads to nothing of ours",
    async (comp) => {
      const empty = path.join(root, "empty");
      mkdirSync(empty);
      if (comp === ".worktrees") symlinkSync(empty, path.join(repo, ".worktrees"));
      else {
        mkdirSync(path.join(repo, ".worktrees"));
        symlinkSync(empty, path.join(repo, ".worktrees/.agents"));
      }
      expect(await cleanupProject(project(), SLUG)).toBeNull();
      expect(readdirSync(empty)).toEqual([]);
    },
  );

  it("unlinks a symlink inside our folder without following it", async () => {
    const dir = addWorktree("feat/x", { push: true });
    symlinkSync(victim, path.join(dir, "escape"));
    symlinkSync(victim, path.join(base(), "escape2"));
    const r = await cleanupProject(project(), SLUG);
    expect(r).toMatchObject({ removed: true, deleted: ["feat/x"] });
    expect(existsSync(base())).toBe(false);
    expect(victimIntact()).toBe(true);
  });
});

describe("the repository's worktrees metadata folder", () => {
  it("refuses when it is a symlink to a folder holding a forged admin dir", async () => {
    const dir = addWorktree("feat/x", { push: true });
    renameSync(wtAdmin(), path.join(root, "moved-admin"));
    symlinkSync(path.join(root, "moved-admin"), wtAdmin());
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/worktrees folder is not a plain folder/);
    expect(r?.removed).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(path.join(root, "moved-admin"))).toHaveLength(1);
  });

  it.each(["..x", ".hidden"])("never removes an admin dir named %s", async (id) => {
    addWorktree("feat/x", { push: true });
    const forged = path.join(wtAdmin(), id);
    mkdirSync(forged);
    writeFileSync(path.join(forged, "gitdir"), `${base()}/forged/.git\n`);
    // git lists the forged dir as a worktree of ours; it can't be matched, so nothing is removed.
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/metadata; left in place$/);
    expect(r).toMatchObject({ removed: false, deleted: [] });
    expect(existsSync(path.join(forged, "gitdir"))).toBe(true);
    expect(existsSync(path.join(base(), "feat/x"))).toBe(true);
  });

  it("never removes an admin dir that is a symlink to a folder outside", async () => {
    addWorktree("feat/x", { push: true });
    writeFileSync(path.join(victim, "gitdir"), `${base()}/forged/.git\n`);
    symlinkSync(victim, path.join(wtAdmin(), "linked"));
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/metadata; left in place$/);
    expect(r?.removed).toBe(false);
    expect(victimIntact()).toBe(true);
    expect(existsSync(path.join(victim, "gitdir"))).toBe(true);
  });

  it("treats a gitdir file over 4096 bytes as no match and removes nothing", async () => {
    const dir = addWorktree("feat/x", { push: true });
    const [id] = adminIds();
    const file = path.join(wtAdmin(), id as string, "gitdir");
    writeFileSync(file, `${readFileSync(file, "utf8").trim()}${" ".repeat(5000)}\n`);
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toBe("couldn't match `feat/x`'s metadata; left in place");
    expect(r).toMatchObject({ removed: false, deleted: [] });
    expect(existsSync(dir)).toBe(true);
    expect(adminIds()).toHaveLength(1);
  });

  it("keeps a forged admin dir whose gitdir points outside our folder", async () => {
    addWorktree("feat/x", { push: true });
    const forged = path.join(wtAdmin(), "forged");
    mkdirSync(forged);
    writeFileSync(path.join(forged, "gitdir"), `${path.join(victim, ".git")}\n`);
    writeFileSync(path.join(forged, "keep.txt"), "precious");
    await cleanupProject(project(), SLUG);
    expect(readFileSync(path.join(forged, "keep.txt"), "utf8")).toBe("precious");
    expect(victimIntact()).toBe(true);
  });

  it("keeps a forged admin dir whose gitdir climbs out of our folder with ..", async () => {
    addWorktree("feat/x", { push: true });
    const forged = path.join(wtAdmin(), "forged");
    mkdirSync(forged);
    writeFileSync(path.join(forged, "gitdir"), `${base()}/../../../../victim/.git\n`);
    await cleanupProject(project(), SLUG);
    expect(existsSync(path.join(forged, "gitdir"))).toBe(true);
  });

  it("skips the whole project when one of our worktrees' metadata can't be matched", async () => {
    const dir = addWorktree("feat/x", { push: true });
    const other = addWorktree("feat/y", { push: true });
    const [id] = adminIds();
    renameSync(path.join(wtAdmin(), id as string), path.join(wtAdmin(), `.${id}`));
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toMatch(/^couldn't match .*'s metadata; left in place$/);
    expect(r).toMatchObject({ removed: false, deleted: [], kept: [] });
    expect(existsSync(dir) && existsSync(other)).toBe(true);
    expect(adminIds()).toHaveLength(2);
    expect(g(repo, "show-ref", "--verify", "refs/heads/feat/y")).toContain("refs/heads/feat/y");
  });
});

describe("git itself", () => {
  it("runs no planted fsmonitor or hook through the whole cleanup", async () => {
    const marker = path.join(root, "marker");
    const script = (file: string) => {
      writeFileSync(file, `#!/bin/sh\necho ran >> '${marker}'\n`);
      chmodSync(file, 0o755);
    };
    script(path.join(root, "fsmonitor.sh"));
    mkdirSync(path.join(root, "hooks"));
    script(path.join(root, "hooks", "reference-transaction"));
    mkdirSync(path.join(repo, ".git/hooks"), { recursive: true });
    script(path.join(repo, ".git/hooks/reference-transaction"));
    addWorktree("feat/x", { push: true });
    g(repo, "config", "core.fsmonitor", path.join(root, "fsmonitor.sh"));
    g(repo, "config", "core.hooksPath", path.join(root, "hooks"));
    rmSync(marker, { force: true });
    const r = await cleanupProject(project(), SLUG);
    expect(r?.deleted).toEqual(["feat/x"]); // `branch -D` really ran, and ran no hook
    expect(existsSync(marker)).toBe(false);
  });

  it("counts commits even when a file named like the ref sits in the main checkout", async () => {
    addWorktree("feat/x", { commits: 2 });
    mkdirSync(path.join(repo, "refs/heads/feat"), { recursive: true });
    writeFileSync(path.join(repo, "refs/heads/feat/x"), "not a ref");
    const r = await cleanupProject(project(), SLUG);
    expect(r?.error).toBeUndefined();
    expect(r?.kept).toEqual([{ branch: "feat/x", commits: 2 }]);
  });

  it.each([
    ["git hides a ref named bad..name from worktree list, so it is never a branch", "bad..name"],
    ["skips a branch named -D, which would be taken for an option", "-D"],
    ["skips a branch named @foo, since a leading @ can expand", "@foo"],
  ])("%s", async (_title, bad) => {
    const dir = addWorktree("feat/x", { push: true });
    const [id] = adminIds();
    const sha = g(repo, "rev-parse", "HEAD").trim();
    const refFile = path.join(repo, ".git/refs/heads", bad);
    writeFileSync(refFile, `${sha}\n`);
    writeFileSync(path.join(wtAdmin(), id as string, "HEAD"), `ref: refs/heads/${bad}\n`);
    const r = await cleanupProject(project(), SLUG);
    expect(r).toMatchObject({ removed: true, deleted: [], kept: [] });
    expect(r?.error).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(refFile)).toBe(true);
    expect(existsSync(path.join(repo, ".git/refs/heads/feat/x"))).toBe(true);
  });

  it("refuses a non-repo subfolder of a parent repo that holds our folder", async () => {
    const sub = path.join(repo, "sub");
    mkdirSync(path.join(sub, ".worktrees/.agents", SLUG), { recursive: true });
    const r = await cleanupProject(project(sub), SLUG);
    expect(r).toEqual({
      project: "web",
      removed: false,
      deleted: [],
      kept: [],
      error: "couldn't clean up: not a git repository",
    });
    expect(existsSync(path.join(sub, ".worktrees/.agents", SLUG))).toBe(true);
  });
});

describe("a repository whose .git is not its own plain folder", () => {
  const snapshot = (other: string) => [
    g(other, "show-ref"),
    readdirSync(path.join(other, ".git/worktrees")).sort().join(),
    g(other, "worktree", "list", "--porcelain"),
  ];
  async function setup(mode: "file" | "symlink" | "commondir") {
    const other = path.join(root, "other");
    mkdirSync(other);
    g(other, "init", "-q", "-b", "main");
    commit(other, "init");
    mkdirSync(base(), { recursive: true });
    g(other, "worktree", "add", "-q", "-b", "feat/x", path.join(base(), "feat/x"));
    const otherGit = path.join(other, ".git");
    if (mode === "commondir") {
      writeFileSync(path.join(repo, ".git/commondir"), `${otherGit}\n`);
    } else {
      rmSync(path.join(repo, ".git"), { recursive: true });
      if (mode === "file") writeFileSync(path.join(repo, ".git"), `gitdir: ${otherGit}\n`);
      else symlinkSync(otherGit, path.join(repo, ".git"));
    }
    return other;
  }

  it.each(["file", "symlink", "commondir"] as const)(
    "refuses a .git %s pointing at a second repository and leaves it unchanged",
    async (mode) => {
      const other = await setup(mode);
      const before = snapshot(other);
      const r = await cleanupProject(project(), SLUG);
      expect(r?.error).toBe("the repository's .git is not a plain folder; left in place");
      expect(r).toMatchObject({ removed: false, deleted: [] });
      expect(snapshot(other)).toEqual(before);
      expect(existsSync(path.join(base(), "feat/x"))).toBe(true);
    },
  );
});

describe("a removal that fails", () => {
  it("reports it, and skips the metadata and branch steps", async (ctx) => {
    if (process.getuid?.() === 0) return ctx.skip();
    addWorktree("feat/x", { push: true });
    const locked = path.join(base(), "locked");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "f"), "x");
    chmodSync(locked, 0o500);
    try {
      const r = await cleanupProject(project(), SLUG);
      expect(r).toMatchObject({
        removed: false,
        deleted: [],
        error: `couldn't remove .worktrees/.agents/${SLUG}: EACCES`,
      });
      expect(adminIds()).toHaveLength(1);
      expect(g(repo, "show-ref", "--verify", "refs/heads/feat/x")).toContain("feat/x");
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
