import { expect, test } from "vitest";
import { loadConfig } from "../config.ts";
import {
  agentConfigDir,
  agentWorkdir,
  buildAgentEnv,
  buildRuntimeSpec,
  resolveClaudeToken,
} from "./runtime-spec.ts";

const base = {
  DATABASE_URL: "postgres://x",
  FACTORY_SECRET_KEY: "k".repeat(40),
  FACTORY_HOME: "/tmp/of-home",
};

test("env is an allowlist: secrets and unknown vars never reach the agent", () => {
  const env = buildAgentEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      DATABASE_URL: "postgres://secret",
      FACTORY_SECRET_KEY: "s".repeat(40),
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CODE_OAUTH_TOKEN: "server-own",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      SSH_AUTH_SOCK: "/tmp/ssh",
      RANDOM_NEW_VAR: "x",
    },
    { configDir: "/w/.claude-config", token: "agent-token" },
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
  });
  expect(env.DATABASE_URL).toBeUndefined();
  expect(env.FACTORY_SECRET_KEY).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("config: new vars and defaults", () => {
  const c = loadConfig(base);
  expect(c.claudeBin).toBe("claude");
  expect(c.claudeToken).toBeUndefined();
  expect(c.devModel).toBeUndefined();
  const d = loadConfig({
    ...base,
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    FACTORY_CLAUDE_BIN: "/opt/claude",
    FACTORY_DEV_MODEL: "haiku",
  });
  expect([d.claudeToken, d.claudeBin, d.devModel]).toEqual(["t", "/opt/claude", "haiku"]);
  expect(resolveClaudeToken(d)).toBe("t");
});

test("runtime spec: workdir, config dir, model, auto mode", () => {
  const c = loadConfig({ ...base, FACTORY_DEV_MODEL: "haiku" });
  expect(agentWorkdir(c, "dev")).toBe("/tmp/of-home/agents/dev");
  expect(agentConfigDir(c, "dev")).toBe("/tmp/of-home/agents/dev/.claude-config");
  const spec = buildRuntimeSpec({ id: "a1", slug: "dev" }, c, "tok", { PATH: "/bin" });
  expect(spec).toEqual({
    agentId: "a1",
    slug: "dev",
    cwd: "/tmp/of-home/agents/dev",
    claudeBin: "claude",
    model: "haiku",
    permissionMode: "auto",
    env: {
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/tmp/of-home/agents/dev/.claude-config",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    },
  });
});
