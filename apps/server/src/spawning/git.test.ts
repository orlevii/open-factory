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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The runner probes `git --version` once; shims answer it so they only see real calls.
const VERSION = (v = "2.50.1") =>
  `case " $* " in *" --version "*) echo "git version ${v}"; exit 0;; esac`;

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
    [["rev-list", "--count", "--output=/x", "--not", "--remotes", "--"]],
    [["rev-list", "--count", "refs/heads/x", "--not", "--remotes", "--alternate-refs", "--"]],
    [["rev-list", "--count", "refs/heads/x", "--not", "--remotes", "--", "--"]],
    [["show-ref", "--verify", "-q", "--head"]],
    [["check-ref-format", "--branch", "-x"]],
    [["branch", "-D", "--end-of-options", "-x"]],
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

  it("no allowed command runs a planted hook or the planted fsmonitor config", async () => {
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

describe("promisor lazy fetch", () => {
  // A repo that claims a promisor remote, whose "ssh" is a payload, and a ref at a missing oid.
  function plantPromisor(repo: string) {
    const marker = path.join(root, "ssh-marker");
    const ssh = path.join(root, "ssh.sh");
    script(ssh, `touch "${marker}"\nexit 1`);
    plain(repo, "config", "core.repositoryformatversion", "1");
    plain(repo, "config", "extensions.partialClone", "origin");
    plain(repo, "config", "remote.origin.promisor", "true");
    plain(repo, "config", "remote.origin.url", "ssh://x/y");
    plain(repo, "config", "core.sshCommand", ssh);
    writeFileSync(path.join(repo, ".git/refs/heads/z"), `${"a".repeat(40)}\n`);
    return marker;
  }
  const shapes: string[][] = [
    ["rev-list", "--count", "refs/heads/z", "--not", "--remotes", "--"],
    ["show-ref", "--verify", "-q", "refs/heads/z"],
    ["branch", "-D", "--end-of-options", "z"],
  ];

  it("the plant works: git without GIT_NO_LAZY_FETCH runs the payload", () => {
    const repo = makeRepo();
    const marker = plantPromisor(repo);
    for (const args of shapes) {
      rmSync(marker, { force: true });
      try {
        plain(repo, ...args);
      } catch {}
      expect(existsSync(marker), args.join(" ")).toBe(true);
    }
  });

  it("no allowed shape triggers a lazy fetch", async () => {
    const repo = makeRepo();
    const marker = plantPromisor(repo);
    for (const [i, args] of shapes.entries()) {
      await git(repo, args as never).catch((e) => expect(e).toBeInstanceOf(GitError));
      expect(existsSync(marker), `${i}: ${args.join(" ")}`).toBe(false);
    }
  });

  it("refuses to run on a git older than 2.44", async () => {
    const repo = makeRepo();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    script(path.join(bin, "git"), `${VERSION("2.43.0")}\necho ok`);
    process.env.PATH = `${bin}:${saved.PATH}`;
    // a fresh module: the probe result is memoised per process
    vi.resetModules();
    const fresh = await import("./git");
    await expect(fresh.git(repo, ["rev-parse", "--show-toplevel"])).rejects.toBeInstanceOf(
      fresh.GitTooOldError,
    );
  });
});

describe("child environment", () => {
  it("passes PATH, HOME and the fixed git variables only", async () => {
    const repo = makeRepo();
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const dump = path.join(root, "env-dump");
    script(path.join(bin, "git"), `${VERSION()}\nexport -p > "${dump}"`);
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
        "GIT_NO_LAZY_FETCH",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
      ]).toContain(k);
    expect(text).not.toMatch(/GIT_EXTERNAL_DIFF|GIT_SSH_COMMAND|SECRET_TOKEN/);
    expect(text).toContain(`GIT_CEILING_DIRECTORIES="${root}"`);
    expect(text).toContain('GIT_CONFIG_NOSYSTEM="1"');
    expect(text).toContain('GIT_NO_LAZY_FETCH="1"');
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
    script(path.join(bin, "git"), `${VERSION()}\nexec sleep 5`);
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
      `${VERSION()}
printf '%s\\n' "$*" >> "${log}"
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

  it("every call starts with the fixed hardening flags", async () => {
    const repo = makeRepo();
    const calls = shim(1);
    await git(repo, ["rev-parse", "--show-toplevel"]);
    await git(repo, ["show-ref", "--verify", "-q", "refs/heads/x"]);
    const all = calls();
    expect(all.length).toBeGreaterThan(2);
    for (const c of all)
      expect(c).toMatch(
        /^--no-optional-locks -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false /,
      );
  });

  it("does not retry a second time", async () => {
    const repo = makeRepo();
    const calls = shim(5);
    await expect(git(repo, ["rev-parse", "--show-toplevel"])).rejects.toBeInstanceOf(GitError);
    expect(calls()).toHaveLength(2);
  });
});
