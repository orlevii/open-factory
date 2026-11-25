import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAllowed, GitError, GitMissingError, git } from "./git";

let root: string;
const saved = { ...process.env };

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "of-git-")));
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(root, { recursive: true, force: true });
});

const plain = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

function script(file: string, body: string) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function makeRepo(): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  plain(repo, "init", "-q", "-b", "main");
  plain(repo, "commit", "-q", "--allow-empty", "-m", "init");
  plain(repo, "branch", "x");
  plain(repo, "branch", "y");
  return repo;
}

describe("assertAllowed", () => {
  it.each([
    [["status"]],
    [["worktree", "prune"]],
    [["worktree", "remove", "x"]],
    [["fetch"]],
    [["gc"]],
    [["diff"]],
    [["rev-list", "--count", "refs/heads/x", "--not", "--remotes"]],
    [["branch", "-D", "x"]],
  ])("refuses %j", (args) => {
    expect(() => assertAllowed(args)).toThrow(/not an allowed command/);
  });

  it("accepts the listed shapes", () => {
    for (const args of [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--git-common-dir"],
      ["worktree", "list", "--porcelain", "-z"],
      ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
      ["show-ref", "--verify", "-q", "refs/heads/x"],
      ["check-ref-format", "--branch", "x"],
      ["rev-list", "--count", "refs/heads/x", "--not", "--remotes", "--"],
      ["rev-list", "--count", "refs/heads/x", "--not", "--remotes", "refs/heads/main", "--"],
      ["branch", "-D", "--end-of-options", "x"],
    ])
      expect(() => assertAllowed(args)).not.toThrow();
  });

  it("is enforced by git() before anything runs", async () => {
    await expect(git(root, ["status"] as never)).rejects.toThrow(/not an allowed command/);
  });
});

describe("hardening against a planted repo config", () => {
  function plant(repo: string) {
    const fsMarker = path.join(root, "fs-marker");
    const hookMarker = path.join(root, "hook-marker");
    const fsmonitor = path.join(root, "fsmonitor.sh");
    script(fsmonitor, `touch "${fsMarker}"`);
    const hooks = path.join(root, "hooks");
    mkdirSync(hooks);
    for (const h of ["reference-transaction", "post-checkout", "pre-commit"])
      script(path.join(hooks, h), `touch "${hookMarker}"`);
    plain(repo, "config", "core.fsmonitor", fsmonitor);
    plain(repo, "config", "core.hooksPath", hooks);
    return { fsMarker, hookMarker };
  }

  it("the plant works: plain git runs the hook and the fsmonitor", () => {
    const repo = makeRepo();
    const { fsMarker, hookMarker } = plant(repo);
    plain(repo, "branch", "-D", "y");
    expect(existsSync(hookMarker)).toBe(true);
    plain(repo, "status");
    expect(existsSync(fsMarker)).toBe(true);
  });

  it("no allowed command runs a hook or the fsmonitor", async () => {
    const repo = makeRepo();
    const { fsMarker, hookMarker } = plant(repo);
    const tolerant = (p: Promise<string>) => p.catch((e) => expect(e).toBeInstanceOf(GitError));
    await git(repo, ["rev-parse", "--show-toplevel"]);
    await git(repo, ["rev-parse", "--git-common-dir"]);
    await git(repo, ["worktree", "list", "--porcelain", "-z"]);
    await tolerant(git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]));
    await git(repo, ["show-ref", "--verify", "-q", "refs/heads/x"]);
    await git(repo, ["check-ref-format", "--branch", "x"]);
    await git(repo, ["rev-list", "--count", "refs/heads/x", "--not", "--remotes", "--"]);
    await git(repo, ["branch", "-D", "--end-of-options", "x"]);
    expect(plain(repo, "branch", "--list", "x")).toBe("");
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(fsMarker)).toBe(false);
  });
});

describe("child environment", () => {
  it("passes PATH, HOME and the fixed git variables only", async () => {
    const repo = makeRepo();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const dump = path.join(root, "env-dump");
    script(path.join(bin, "git"), `export -p > "${dump}"`);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.GIT_EXTERNAL_DIFF = "/bin/evil";
    process.env.GIT_SSH_COMMAND = "evil";
    process.env.SECRET_TOKEN = "s3cr3t";
    await git(repo, ["rev-parse", "--show-toplevel"]);
    const text = readFileSync(dump, "utf8");
    const keys = [...text.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
    for (const k of keys)
      expect([
        "PATH",
        "HOME",
        "GIT_PAGER",
        "GIT_TERMINAL_PROMPT",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_OPTIONAL_LOCKS",
        "GIT_CEILING_DIRECTORIES",
        "LC_ALL",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
      ]).toContain(k);
    expect(text).not.toMatch(/GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|SECRET_TOKEN/);
    expect(text).toContain(`GIT_CEILING_DIRECTORIES="${root}"`);
    expect(text).toContain('GIT_CONFIG_NOSYSTEM="1"');
  });
});

describe("failure modes", () => {
  it("does not take a plain subfolder of a parent repo for a repo", async () => {
    const repo = makeRepo();
    const sub = path.join(repo, "sub");
    mkdirSync(sub);
    await expect(git(sub, ["rev-parse", "--show-toplevel"])).rejects.toBeInstanceOf(GitError);
    expect((await git(repo, ["rev-parse", "--show-toplevel"])).trim()).toBe(repo);
  });

  it("reports a missing git", async () => {
    const repo = makeRepo();
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    process.env.PATH = empty;
    await expect(git(repo, ["rev-parse", "--show-toplevel"])).rejects.toBeInstanceOf(
      GitMissingError,
    );
  });

  it("kills a slow git at the timeout", async () => {
    const repo = makeRepo();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    script(path.join(bin, "git"), "exec sleep 5");
    process.env.PATH = `${bin}:${saved.PATH}`;
    const started = Date.now();
    await expect(
      git(repo, ["rev-parse", "--show-toplevel"], { timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(GitError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("dubious ownership", () => {
  function shim(failTimes: number) {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const log = path.join(root, "calls");
    const count = path.join(root, "count");
    writeFileSync(count, "0");
    script(
      path.join(bin, "git"),
      `printf '%s\\n' "$*" >> "${log}"
n=$(cat "${count}")
echo $((n + 1)) > "${count}"
if [ "$n" -lt ${failTimes} ]; then
  echo "fatal: detected dubious ownership in repository at '$PWD'" >&2
  exit 128
fi
echo ok`,
    );
    process.env.PATH = `${bin}:${saved.PATH}`;
    return () => readFileSync(log, "utf8").trim().split("\n");
  }

  it("retries once with the exact repo path, never * and never git config", async () => {
    const repo = makeRepo();
    const calls = shim(1);
    expect((await git(repo, ["rev-parse", "--show-toplevel"])).trim()).toBe("ok");
    const all = calls();
    expect(all).toHaveLength(2);
    expect(all[0]).not.toContain("safe.directory");
    expect(all[1]).toContain(`-c safe.directory=${repo} rev-parse --show-toplevel`);
    expect(all.join("\n")).not.toMatch(/safe\.directory=\*|\bconfig\b/);
  });

  it("does not retry a second time", async () => {
    const repo = makeRepo();
    const calls = shim(5);
    await expect(git(repo, ["rev-parse", "--show-toplevel"])).rejects.toBeInstanceOf(GitError);
    expect(calls()).toHaveLength(2);
  });
});
