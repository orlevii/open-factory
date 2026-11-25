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

/** git is older than the minimum that honours GIT_NO_LAZY_FETCH (2.44); the caller reports it like a missing git. */
export class GitTooOldError extends Error {
  constructor(found: string) {
    super(`git ${found} is too old: 2.44 or newer is required (GIT_NO_LAZY_FETCH)`);
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

// A free string slot must be a value, never an option (`--output=`, `--alternate-refs`, ...).
const value = (v: unknown): boolean => typeof v === "string" && !v.startsWith("-");

export function assertAllowed(args: readonly string[]): void {
  const ok =
    FIXED.some((f) => same(args, f)) ||
    (args.length === 4 &&
      args[0] === "show-ref" &&
      args[1] === "--verify" &&
      args[2] === "-q" &&
      value(args[3])) ||
    (args.length === 3 &&
      args[0] === "check-ref-format" &&
      args[1] === "--branch" &&
      value(args[2])) ||
    (args.length >= 6 &&
      args[0] === "rev-list" &&
      args[1] === "--count" &&
      value(args[2]) &&
      args[3] === "--not" &&
      args[4] === "--remotes" &&
      args[args.length - 1] === "--" &&
      args.slice(5, -1).every(value)) ||
    (args.length === 4 &&
      args[0] === "branch" &&
      args[1] === "-D" &&
      args[2] === "--end-of-options" &&
      value(args[3]));
  if (!ok) throw new Error(`git ${args.join(" ")} is not an allowed command`);
}

// Empty and relative entries mean "the current directory" to a lookup; the cwd is a repo agents write to.
const safePath = (p: string | undefined): string =>
  (p ?? "")
    .split(path.delimiter)
    .filter((d) => d !== "" && path.isAbsolute(d))
    .join(path.delimiter);

function env(repo: string): NodeJS.ProcessEnv {
  return {
    PATH: safePath(process.env.PATH),
    HOME: process.env.HOME,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(repo),
    LC_ALL: "C",
    // A planted promisor remote must not make a read-only command fetch (and run
    // core.sshCommand / uploadpack). Needs git >= 2.44; see GitTooOldError.
    GIT_NO_LAZY_FETCH: "1",
  };
}

// `prefix` is the fixed flags; a GitError carries only the caller's `args`, so its subcommand is args[0].
function run(repo: string, prefix: string[], args: string[], timeoutMs: number): Promise<string> {
  const childEnv = env(repo);
  // An empty PATH makes the spawn look in the current directory (the repo): there is no git to run.
  if (!childEnv.PATH) return Promise.reject(new GitMissingError());
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      [...prefix, ...args],
      { cwd: repo, env: childEnv, timeout: timeoutMs, maxBuffer: 1 << 20, shell: false },
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

let versionChecked = false;

// Older git ignores GIT_NO_LAZY_FETCH silently, so refuse to run on it. An internal
// call outside the allowlist; only a success is memoised.
async function checkVersion(repo: string, timeoutMs: number): Promise<void> {
  if (versionChecked) return;
  const out = await run(repo, BASE, ["--version"], timeoutMs);
  const m = /git version (\d+)\.(\d+)/.exec(out);
  const found = m?.[0].replace("git version ", "") ?? out.trim();
  if (!m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 44))
    throw new GitTooOldError(found);
  versionChecked = true;
}

/** `repo` is the realpath the caller computed. */
export async function git(
  repo: string,
  args: GitAllowed,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<string> {
  assertAllowed(args);
  await checkVersion(repo, timeoutMs);
  try {
    return await run(repo, BASE, args, timeoutMs);
  } catch (e) {
    if (e instanceof GitError && /detected dubious ownership/.test(e.stderr))
      // D7: the exact repo path for this one call; never "*", never written to any config.
      return run(repo, [...BASE, "-c", `safe.directory=${repo}`], args, timeoutMs);
    throw e;
  }
}
