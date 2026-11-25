import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assertPluginFloor,
  checkImageClaudeVersion,
  dockerCheckEnv,
  versionCheckEnv,
} from "./claude-flags.ts";

test("the host version check gets only PATH and HOME, never the agent's config dir", () => {
  expect(
    versionCheckEnv({
      PATH: "/bin",
      HOME: "/home/me",
      CLAUDE_CONFIG_DIR: "/agents/x/.claude-config",
      DATABASE_URL: "postgres://x",
      FACTORY_SECRET_KEY: "k",
      ANTHROPIC_API_KEY: "a",
    }),
  ).toEqual({ PATH: "/bin", HOME: "/home/me" });
});

test("a Claude Code below the floor fails the start, naming both versions", async () => {
  const old = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_VERSION: "2.1.1" } });
  await expect(assertPluginFloor(old.bin, { PATH: process.env.PATH ?? "" })).rejects.toThrow(
    "Claude Code 2.1.1 is too old; update it to 2.1.331 or later.",
  );
});

test("a Claude Code at the floor passes", async () => {
  const floor = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_VERSION: "2.1.331" } });
  await expect(assertPluginFloor(floor.bin, { PATH: process.env.PATH ?? "" })).resolves.toBe(
    undefined,
  );
});

/** A `docker` that logs its argv to `count` and prints `--version` as `version`. */
function fakeDocker(version: string): { dir: string; count: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
  const count = path.join(dir, "runs.log");
  const bin = path.join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${count}'\necho '${version} (Claude Code)'\n`);
  chmodSync(bin, 0o755);
  return { dir, count };
}

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

const runsOf = (count: string) => readFileSync(count, "utf8").trim().split("\n");

test("the image check runs docker once per digest, offline, and caches the pass", async () => {
  const { dir, count } = fakeDocker("2.1.331");
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;

  await checkImageClaudeVersion("factory/agent:1", "sha256:one");
  await checkImageClaudeVersion("factory/agent:1", "sha256:one");
  expect(runsOf(count)).toEqual([
    "run --rm --network none --security-opt no-new-privileges:true --entrypoint claude factory/agent:1 --version",
  ]);

  await checkImageClaudeVersion("factory/agent:2", "sha256:two");
  expect(runsOf(count)).toHaveLength(2);
});

test("an image below the floor is refused, and the refusal is not cached", async () => {
  const { dir, count } = fakeDocker("2.1.1");
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;

  await expect(checkImageClaudeVersion("factory/old:1", "sha256:old")).rejects.toThrow(
    "Claude Code 2.1.1 is too old; update it to 2.1.331 or later.",
  );
  await expect(checkImageClaudeVersion("factory/old:1", "sha256:old")).rejects.toThrow("too old");
  expect(runsOf(count)).toHaveLength(2);
});

test("a binary whose version can't be read fails the start", async () => {
  await expect(assertPluginFloor("/nonexistent/claude", { PATH: "/usr/bin" })).rejects.toThrow(
    "printed no readable version",
  );
});

test("the docker probe keeps the daemon variables and nothing else of the server's env", () => {
  expect(
    dockerCheckEnv({
      PATH: "/bin",
      HOME: "/home/me",
      DOCKER_HOST: "unix:///colima.sock",
      DOCKER_CONTEXT: "colima",
      DOCKER_CONFIG: "/cfg",
      ANTHROPIC_API_KEY: "a",
      DATABASE_URL: "postgres://x",
    }),
  ).toEqual({
    PATH: "/bin",
    HOME: "/home/me",
    DOCKER_HOST: "unix:///colima.sock",
    DOCKER_CONTEXT: "colima",
    DOCKER_CONFIG: "/cfg",
  });
});

test("DOCKER_HOST reaches the image probe, and a failure's stderr is redacted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
  writeFileSync(
    path.join(dir, "docker"),
    '#!/bin/sh\necho "host=$DOCKER_HOST key=$ANTHROPIC_API_KEY" >&2\necho "pull from https://user:pw@reg.example/x sk-ant-SECRET123" >&2\nexit 1\n',
  );
  chmodSync(path.join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  const savedHost = process.env.DOCKER_HOST;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.DOCKER_HOST = "unix:///colima.sock";
  process.env.ANTHROPIC_API_KEY = "leak";
  try {
    const err = await checkImageClaudeVersion("factory/x:1", "sha256:host").catch(
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("host=unix:///colima.sock");
    expect(msg).toContain("key=\n");
    expect(msg).not.toContain("pw@");
    expect(msg).not.toContain("SECRET123");
  } finally {
    if (savedHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedHost;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
