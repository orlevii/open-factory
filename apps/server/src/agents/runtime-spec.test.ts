import { isFactoryEnvName, templateYamlSchema } from "@open-factory/shared";
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
  const env = buildAgentEnv(
    serverEnv,
    {
      configDir: "/w/.claude-config",
      slug: "lead",
      credential: { kind: "oauth_token", value: "agent-token" },
      secrets: { GH_TOKEN: "gh" },
      agentToken: "t",
    },
    "local",
  );
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
    OPEN_FACTORY_AGENT_TOKEN: "t",
  });
});

test("secrets can never override PATH, the credential var, the config dir or the git identity", () => {
  const env = buildAgentEnv(
    serverEnv,
    {
      configDir: "/c",
      slug: "a1",
      credential: { kind: "oauth_token", value: "factory-token" },
      agentToken: "t",
      secrets: {
        PATH: "/evil",
        ANTHROPIC_API_KEY: "evil-key",
        CLAUDE_CODE_OAUTH_TOKEN: "evil-token",
        CLAUDE_CONFIG_DIR: "/evil",
        GIT_AUTHOR_NAME: "evil",
        GH_TOKEN: "gh",
      },
    },
    "local",
  );
  expect(env.PATH).toBe("/usr/bin");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("factory-token");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
  expect(env.GIT_AUTHOR_NAME).toBe("a1");
  expect(env.GH_TOKEN).toBe("gh");
  // a secret named like the other credential var is not a way to set two credentials
  expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
});

test("api_key credentials set ANTHROPIC_API_KEY and never the OAuth var", () => {
  const env = buildAgentEnv(
    serverEnv,
    {
      configDir: "/c",
      slug: "a1",
      credential: { kind: "api_key", value: "k" },
      secrets: {},
      agentToken: "t",
    },
    "local",
  );
  expect(env.ANTHROPIC_API_KEY).toBe("k");
  expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  for (const k of ["DATABASE_URL", "FACTORY_SECRET_KEY", "SSH_AUTH_SOCK", "RANDOM_NEW_VAR"])
    expect(env).not.toHaveProperty(k);
});

test("the server's own ANTHROPIC_*/CLAUDE_* never leak; exactly one credential var is set", () => {
  for (const kind of ["oauth_token", "api_key"] as const) {
    const env = buildAgentEnv(
      serverEnv,
      {
        configDir: "/c",
        slug: "a1",
        credential: { kind, value: "agent" },
        secrets: {},
        agentToken: "t",
      },
      "local",
    );
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
    {
      configDir: "/a",
      slug: "aa",
      credential: { kind: "oauth_token", value: "A" },
      secrets: {},
      agentToken: "t",
    },
    "local",
  );
  const b = buildAgentEnv(
    {},
    {
      configDir: "/b",
      slug: "bb",
      credential: { kind: "oauth_token", value: "B" },
      secrets: {},
      agentToken: "t",
    },
    "local",
  );
  expect([a.CLAUDE_CODE_OAUTH_TOKEN, b.CLAUDE_CODE_OAUTH_TOKEN]).toEqual(["A", "B"]);
});

const extra = {
  configDir: "/w/.claude-config",
  slug: "lead",
  credential: { kind: "oauth_token" as const, value: "agent-token" },
  secrets: { GH_TOKEN: "gh" },
  agentToken: "t",
};

test.each(["local", "docker"] as const)("%s: server-only vars never leak", (rt) => {
  const env = buildAgentEnv(
    {
      ...serverEnv,
      DATABASE_URL: "x",
      FACTORY_SECRET_KEY: "y",
      ANTHROPIC_API_KEY: "z",
      CLAUDE_FOO: "w",
      RANDOM_VAR: "v",
    },
    extra,
    rt,
  );
  for (const k of [
    "DATABASE_URL",
    "FACTORY_SECRET_KEY",
    "CLAUDE_FOO",
    "RANDOM_VAR",
    "SSH_AUTH_SOCK",
  ])
    expect(env).not.toHaveProperty(k);
});

test("docker: no host PATH/HOME/USER/SHELL; OPEN_FACTORY_URL set", () => {
  const env = buildAgentEnv(
    serverEnv,
    { ...extra, agentUrl: "http://host.docker.internal:3000" },
    "docker",
  );
  for (const k of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"])
    expect(env).not.toHaveProperty(k);
  expect(env.OPEN_FACTORY_URL).toBe("http://host.docker.internal:3000");
  expect(env.CLAUDE_CONFIG_DIR).toBe(extra.configDir);
  expect(Object.keys(env).sort()).toEqual(
    [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "GH_TOKEN",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "OPEN_FACTORY_AGENT_TOKEN",
      "OPEN_FACTORY_URL",
    ].sort(),
  );
});

test("local: no OPEN_FACTORY_URL", () => {
  const env = buildAgentEnv(serverEnv, { ...extra, agentUrl: "http://x" }, "local");
  expect(env).not.toHaveProperty("OPEN_FACTORY_URL");
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

test("the agent token is the one variable S6 adds, and a secret can't override it", () => {
  for (const runtime of ["local", "docker"] as const) {
    const env = buildAgentEnv(
      serverEnv,
      {
        configDir: "/w/.claude-config",
        slug: "dev",
        credential: { kind: "oauth_token", value: "cred" },
        secrets: { OPEN_FACTORY_AGENT_TOKEN: "evil" },
        agentToken: "tok",
      },
      runtime,
    );
    expect(env.OPEN_FACTORY_AGENT_TOKEN).toBe("tok");
  }
});

test.each([
  ["oauth_token", "local"],
  ["api_key", "docker"],
] as const)("every name the factory sets is a factory-owned name (%s, %s)", (kind, runtime) => {
  const env = buildAgentEnv(
    serverEnv,
    {
      configDir: "/w/.claude-config",
      slug: "lead",
      credential: { kind, value: "v" },
      secrets: { GH_TOKEN: "gh" },
      agentUrl: "http://host:1",
      agentToken: "t",
    },
    runtime,
  );
  for (const k of ["CLAUDE_CONFIG_DIR", "GIT_AUTHOR_NAME", "OPEN_FACTORY_AGENT_TOKEN"])
    expect(isFactoryEnvName(k), k).toBe(true);
  for (const k of Object.keys(env).filter((k) => k !== "GH_TOKEN" && !(k in serverEnv)))
    expect(isFactoryEnvName(k), k).toBe(true);
});
