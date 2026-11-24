import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GIT_FLAGS, GitError, gitEnv, runGit } from "./git.ts";

const SPEC_FLAGS = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "core.symlinks=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "credential.interactive=false",
];

let bin: string;
let record: string;
let savedPath: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

function fakeGit(body: string) {
  const file = path.join(bin, "git");
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(path.join(tmpdir(), "of-fakegit-"));
  record = path.join(bin, "record.json");
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  for (const k of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND"]) savedEnv[k] = process.env[k];
});
afterEach(() => {
  process.env.PATH = savedPath;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const recordingGit = () =>
  fakeGit(
    `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd()}));\nprocess.stdout.write("ok");`,
  );
const recorded = () => JSON.parse(readFileSync(record, "utf8"));
const url = "https://h/o/r.git";

test("argv starts with exactly the spec flags; file protocol only when allowed", async () => {
  recordingGit();
  expect(GIT_FLAGS({ allowFile: false })).toEqual(SPEC_FLAGS);
  const withFile = GIT_FLAGS({ allowFile: true });
  expect(withFile).toEqual([
    ...SPEC_FLAGS.slice(0, 4),
    "-c",
    "protocol.file.allow=always",
    ...SPEC_FLAGS.slice(4),
  ]);

  const r = await runGit(["ls-remote", url], { cwd: bin, allowFile: false });
  expect(r.stdout).toBe("ok");
  expect(recorded().argv).toEqual([...SPEC_FLAGS, "ls-remote", url]);

  await runGit(["ls-remote", "file:///x"], { cwd: bin, allowFile: true });
  const argv: string[] = recorded().argv;
  expect(argv.slice(0, withFile.length)).toEqual(withFile);
  expect(argv.filter((a) => a === "protocol.file.allow=always")).toHaveLength(1);
});

test("env is exactly the six keys and host git variables do not pass", async () => {
  recordingGit();
  process.env.GIT_DIR = "/evil";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_SSH_COMMAND = "evil";
  await runGit(["ls-remote", url], { cwd: bin, allowFile: false });
  const { env } = recorded();
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(env.GIT_SSH_COMMAND).toBeUndefined();
  expect(env).toMatchObject(gitEnv(process.env));
  expect(gitEnv({ PATH: "/p", HOME: "/h", GIT_DIR: "/x" })).toEqual({
    PATH: "/p",
    HOME: "/h",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "",
    GIT_LFS_SKIP_SMUDGE: "1",
  });
});

test("a dash-leading argument is refused before spawn", async () => {
  recordingGit();
  for (const bad of ["--upload-pack=evil", "-c", "-C"]) {
    const err = await runGit(["fetch", bad], { cwd: bin, allowFile: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
  }
  expect(existsSync(record)).toBe(false);
});

test("a failure rejects with GitError whose message and output are redacted", async () => {
  fakeGit(
    `console.error("fatal: unable to access 'https://u:tok@host/o/r.git/': denied ghp_abc");\nprocess.exit(128);`,
  );
  const err = await runGit(["ls-remote", url], { cwd: bin, allowFile: false }).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  for (const text of [err.output, err.message]) {
    expect(text).not.toContain("tok");
    expect(text).not.toContain("ghp_abc");
  }
  expect(err.output).toContain("https://[redacted]@host");
});

test("a failing command's output keeps only the last 20 lines", async () => {
  fakeGit(`for (let i = 0; i < 40; i++) console.error("line " + i);\nprocess.exit(128);`);
  const err = await runGit(["ls-remote", url], { cwd: bin, allowFile: false }).catch((e) => e);
  expect(err.output.split("\n")).toHaveLength(20);
  expect(err.output).toContain("line 39");
});

test("a command that outlives timeoutMs is killed", async () => {
  fakeGit(
    `require("node:fs").writeFileSync(${JSON.stringify(record)}, String(process.pid));\nsetTimeout(() => {}, 60000);`,
  );
  const t0 = Date.now();
  const err = await runGit(["ls-remote", url], {
    cwd: bin,
    allowFile: false,
    timeoutMs: 2000,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toMatch(/timed out/i);
  expect(Date.now() - t0).toBeLessThan(10_000);
  const pid = Number(readFileSync(record, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("an aborted signal kills the command", async () => {
  fakeGit(`setTimeout(() => {}, 60000);`);
  const ac = new AbortController();
  const p = runGit(["ls-remote", url], { cwd: bin, allowFile: false, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  expect(await p.catch((e) => e)).toBeInstanceOf(GitError);
});

test("without a cwd it runs in an empty temp dir that is removed afterwards", async () => {
  recordingGit();
  mkdirSync(path.join(bin, "x"));
  await runGit(["ls-remote", url], { allowFile: false });
  const cwd = recorded().cwd as string;
  expect(path.basename(cwd)).toMatch(/^of-git-/);
  expect(existsSync(cwd)).toBe(false);
});
