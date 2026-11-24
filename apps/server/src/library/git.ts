/**
 * The hardened git runner for library fetches (spec §6.2). git runs from a fresh empty cwd with an
 * env of exactly six keys, protocol and hook settings pinned on the command line, and never through a
 * shell. Callers pass options through `o`, never as dash-leading `args`.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { capOutput, redactOutput } from "../redact.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** The `-c` settings that start every command, in the order the spec lists them. */
export function GIT_FLAGS(o: { allowFile: boolean }): string[] {
  const settings = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    ...(o.allowFile ? ["protocol.file.allow=always"] : []),
    "core.symlinks=false",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "credential.interactive=false",
  ];
  return settings.flatMap((s) => ["-c", s]);
}

/** Exactly `PATH` and the host `HOME` (git's config and credential helpers) plus four fixed keys. */
export function gitEnv(server: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PATH: server.PATH ?? "",
    HOME: server.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export async function runGit(
  args: string[],
  o: {
    cwd?: string;
    allowFile: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    gitBin?: string;
  },
): Promise<{ stdout: string }> {
  for (const a of args) {
    if (a.startsWith("-")) throw new GitError("git failed: invalid argument.", "");
  }
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownCwd = o.cwd === undefined ? await mkdtemp(path.join(tmpdir(), "of-git-")) : undefined;
  const cwd = o.cwd ?? (ownCwd as string);
  try {
    return await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        o.gitBin ?? "git",
        [...GIT_FLAGS({ allowFile: o.allowFile }), ...args],
        {
          cwd,
          env: gitEnv(process.env),
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          signal: o.signal,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout });
          const output = capOutput(redactOutput(`${stdout}\n${stderr}`));
          const e = err as { killed?: boolean; name?: string };
          const first = String(stderr)
            .split("\n")
            .find((l) => l.trim());
          const reason =
            e.name === "AbortError"
              ? "git was cancelled."
              : e.killed === true
                ? `git timed out after ${timeoutMs / 1000} s.`
                : `git failed: ${redactOutput(first ?? err.message)}`;
          reject(new GitError(reason, output));
        },
      );
    });
  } finally {
    if (ownCwd) await rm(ownCwd, { recursive: true, force: true });
  }
}
