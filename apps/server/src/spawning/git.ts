import { execFile } from "node:child_process";
import path from "node:path";

// The only place the server runs git for spawned-agent cleanup (spec §7.4).
// Read-only plumbing plus `branch -D`; never a shell, never the server's env,
// never anything that reads the working tree or touches the network.

export class GitMissingError extends Error {
  constructor() {
    super("git is not installed or not on PATH");
  }
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`git ${args.join(" ")} failed${code === null ? "" : ` (${code})`}: ${stderr.trim()}`);
  }
}

export type GitAllowed =
  | ["rev-parse", "--show-toplevel"]
  | ["rev-parse", "--git-common-dir"]
  | ["worktree", "list", "--porcelain", "-z"]
  | ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]
  | ["show-ref", "--verify", "-q", string]
  | ["check-ref-format", "--branch", string]
  | ["rev-list", "--count", string, "--not", "--remotes", ...string[]]
  | ["branch", "-D", "--end-of-options", string];

const BASE = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

const FIXED: readonly (readonly string[])[] = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--git-common-dir"],
  ["worktree", "list", "--porcelain", "-z"],
  ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function assertAllowed(args: readonly string[]): void {
  const ok =
    FIXED.some((f) => same(args, f)) ||
    (args.length === 4 &&
      args[0] === "show-ref" &&
      args[1] === "--verify" &&
      args[2] === "-q" &&
      typeof args[3] === "string") ||
    (args.length === 3 &&
      args[0] === "check-ref-format" &&
      args[1] === "--branch" &&
      typeof args[2] === "string") ||
    (args.length >= 6 &&
      args[0] === "rev-list" &&
      args[1] === "--count" &&
      args[3] === "--not" &&
      args[4] === "--remotes" &&
      args[args.length - 1] === "--") ||
    (args.length === 4 &&
      args[0] === "branch" &&
      args[1] === "-D" &&
      args[2] === "--end-of-options" &&
      typeof args[3] === "string");
  if (!ok) throw new Error(`git ${args.join(" ")} is not an allowed command`);
}

function env(repo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(repo),
    LC_ALL: "C",
  };
}

function run(repo: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      args,
      { cwd: repo, env: env(repo), timeout: timeoutMs, maxBuffer: 1 << 20, shell: false },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT")
          return reject(new GitMissingError());
        if (err)
          return reject(
            new GitError(args, String(stderr), typeof err.code === "number" ? err.code : null),
          );
        resolve(String(stdout));
      },
    ),
  );
}

/** `repo` is the realpath the caller computed. */
export async function git(
  repo: string,
  args: GitAllowed,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<string> {
  assertAllowed(args);
  try {
    return await run(repo, [...BASE, ...args], timeoutMs);
  } catch (e) {
    if (e instanceof GitError && /detected dubious ownership/.test(e.stderr))
      // D7: the exact repo path for this one call; never "*", never written to any config.
      return run(repo, [...BASE, "-c", `safe.directory=${repo}`, ...args], timeoutMs);
    throw e;
  }
}
