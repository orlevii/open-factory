import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { excludeFactoryDir } from "./git-exclude.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: "pipe",
  }).toString();

test("appends .factory/ to info/exclude once, append-only, never touching .gitignore", async () => {
  const wd = tmp("wd-");
  git(wd, "init", "-q");
  writeFileSync(path.join(wd, ".gitignore"), "node_modules\n");
  const exclude = path.join(wd, ".git/info/exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  writeFileSync(exclude, "# mine\n*.log");
  expect(await excludeFactoryDir(wd, [wd])).toBe("added");
  expect(await excludeFactoryDir(wd, [wd])).toBe("present");
  expect(readFileSync(exclude, "utf8")).toBe("# mine\n*.log\n.factory/\n");
  expect(readFileSync(path.join(wd, ".gitignore"), "utf8")).toBe("node_modules\n");
  // Git really ignores the uploads.
  mkdirSync(path.join(wd, ".factory/uploads"), { recursive: true });
  writeFileSync(path.join(wd, ".factory/uploads/a.txt"), "x");
  expect(git(wd, "status", "--porcelain")).not.toContain(".factory");
});

test("creates info/exclude when the repository has none", async () => {
  const wd = tmp("wd-");
  git(wd, "init", "-q");
  const { rmSync } = await import("node:fs");
  rmSync(path.join(wd, ".git/info"), { recursive: true, force: true });
  expect(await excludeFactoryDir(wd, [wd])).toBe("added");
  expect(readFileSync(path.join(wd, ".git/info/exclude"), "utf8")).toBe(".factory/\n");
});

test("a worktree writes the common git dir's exclude, shared by every worktree", async () => {
  const repo = tmp("repo-");
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "README.md"), "x");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const wt = path.join(tmp("wts-"), "dev");
  git(repo, "worktree", "add", "-q", wt, "-b", "dev");
  expect(await excludeFactoryDir(wt, [wt, repo])).toBe("added");
  expect(readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".factory/\n");
  expect(existsSync(path.join(repo, ".git/worktrees/dev/info/exclude"))).toBe(false);
  expect(await excludeFactoryDir(wt, [wt, repo])).toBe("present");
  mkdirSync(path.join(wt, ".factory/uploads"), { recursive: true });
  writeFileSync(path.join(wt, ".factory/uploads/a.txt"), "x");
  expect(git(wt, "status", "--porcelain")).not.toContain(".factory");
});

test("no repository: nothing is written", async () => {
  const wd = tmp("wd-");
  expect(await excludeFactoryDir(wd, [wd])).toBe("no_repo");
  expect(existsSync(path.join(wd, ".git"))).toBe(false);
});

test("a .git file pointing outside the allowed roots is refused, and nothing is written there", async () => {
  const wd = tmp("wd-");
  const elsewhere = tmp("elsewhere-");
  writeFileSync(path.join(wd, ".git"), `gitdir: ${elsewhere}\n`);
  expect(await excludeFactoryDir(wd, [wd])).toBe("refused");
  expect(existsSync(path.join(elsewhere, "info"))).toBe(false);
});

test("a symlinked .git, info or exclude is refused", async () => {
  const outside = tmp("outside-");
  const a = tmp("wd-");
  symlinkSync(outside, path.join(a, ".git"));
  expect(await excludeFactoryDir(a, [a])).toBe("refused");

  const b = tmp("wd-");
  git(b, "init", "-q");
  const { rmSync } = await import("node:fs");
  rmSync(path.join(b, ".git/info"), { recursive: true, force: true });
  symlinkSync(outside, path.join(b, ".git/info"));
  expect(await excludeFactoryDir(b, [b])).toBe("refused");

  const c = tmp("wd-");
  git(c, "init", "-q");
  const target = path.join(outside, "target");
  writeFileSync(target, "keep\n");
  rmSync(path.join(c, ".git/info/exclude"), { force: true });
  symlinkSync(target, path.join(c, ".git/info/exclude"));
  expect(await excludeFactoryDir(c, [c])).toBe("refused");
  expect(readFileSync(target, "utf8")).toBe("keep\n");
});
