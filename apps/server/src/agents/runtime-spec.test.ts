import { templateYamlSchema } from "@open-factory/shared";
import { expect, test } from "vitest";
import { buildAgentEnv, buildRuntimeSpec } from "./runtime-spec.ts";

const serverEnv = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
  TMPDIR: "/tmp",
  DATABASE_URL: "postgres://secret",
  FACTORY_SECRET_KEY: "s".repeat(40),
  ANTHROPIC_API_KEY: "server-own",
  CLAUDE_CODE_OAUTH_TOKEN: "server-own",
  CLAUDE_CONFIG_DIR: "/home/u/.claude",
  SSH_AUTH_SOCK: "/tmp/ssh",
  RANDOM_NEW_VAR: "x",
};

test("env is the allowlist plus config dir, credential, secrets and git identity, nothing else", () => {
  const env = buildAgentEnv(serverEnv, {
    configDir: "/w/.claude-config",
    slug: "lead",
    credential: { kind: "oauth_token", value: "agent-token" },
    secrets: { GH_TOKEN: "gh" },
  });
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/u",
    USER: "u",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    TMPDIR: "/tmp",
    CLAUDE_CONFIG_DIR: "/w/.claude-config",
    CLAUDE_CODE_OAUTH_TOKEN: "agent-token",
    GH_TOKEN: "gh",
    GIT_AUTHOR_NAME: "lead",
    GIT_COMMITTER_NAME: "lead",
    GIT_AUTHOR_EMAIL: "lead@open-factory.local",
    GIT_COMMITTER_EMAIL: "lead@open-factory.local",
  });
});

test("api_key credentials set ANTHROPIC_API_KEY and never the OAuth var", () => {
  const env = buildAgentEnv(serverEnv, {
    configDir: "/c",
    slug: "a1",
    credential: { kind: "api_key", value: "k" },
    secrets: {},
  });
  expect(env.ANTHROPIC_API_KEY).toBe("k");
  expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "SSH_AUTH_SOCK", "RANDOM_NEW_VAR"])
    expect(env).not.toHaveProperty(k);
});

test("the server's own ANTHROPIC_*/CLAUDE_* never leak; exactly one credential var is set", () => {
  for (const kind of ["oauth_token", "api_key"] as const) {
    const env = buildAgentEnv(serverEnv, {
      configDir: "/c",
      slug: "a1",
      credential: { kind, value: "agent" },
      secrets: {},
    });
    const creds = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((k) => k in env);
    expect(creds).toHaveLength(1);
    expect(env[creds[0] as string]).toBe("agent");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
    expect(Object.values(env)).not.toContain("server-own");
    expect(Object.values(env)).not.toContain("/home/u/.claude");
  }
});

test("two agents with different credentials get their own values", () => {
  const a = buildAgentEnv(
    {},
    { configDir: "/a", slug: "aa", credential: { kind: "oauth_token", value: "A" }, secrets: {} },
  );
  const b = buildAgentEnv(
    {},
    { configDir: "/b", slug: "bb", credential: { kind: "oauth_token", value: "B" }, secrets: {} },
  );
  expect([a.CLAUDE_CODE_OAUTH_TOKEN, b.CLAUDE_CODE_OAUTH_TOKEN]).toEqual(["A", "B"]);
});

test("runtime spec from the snapshot", () => {
  const config = templateYamlSchema.parse({
    name: "lead",
    display_name: "L",
    runtime: "local",
    model: "haiku",
    effort: "high",
  });
  expect(
    buildRuntimeSpec({
      agentId: "1",
      slug: "lead",
      workdir: "/w",
      env: {},
      claudeBin: "claude",
      config,
      mounts: [],
    }),
  ).toEqual({
    agentId: "1",
    slug: "lead",
    cwd: "/w",
    env: {},
    claudeBin: "claude",
    runtime: "local",
    model: "haiku",
    effort: "high",
    permissionMode: "auto",
    mounts: [],
  });
});

test("model and effort are omitted when the snapshot sets none", () => {
  const config = templateYamlSchema.parse({ name: "lead", display_name: "L", runtime: "local" });
  const spec = buildRuntimeSpec({
    agentId: "1",
    slug: "lead",
    workdir: "/w",
    env: {},
    claudeBin: "claude",
    config,
    mounts: [],
  });
  expect(spec).not.toHaveProperty("model");
  expect(spec).not.toHaveProperty("effort");
});
