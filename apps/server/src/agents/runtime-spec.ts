import path from "node:path";
import type { AgentRuntimeSpec } from "@open-factory/harness";
import type { Config } from "../config.ts";

/** Copied from the server env when set. Everything else is withheld from agents (fail closed). */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
] as const;

export const agentWorkdir = (config: Config, slug: string) =>
  path.join(config.factoryHome, "agents", slug);
export const agentConfigDir = (config: Config, slug: string) =>
  path.join(agentWorkdir(config, slug), ".claude-config");

/** The one place the agent's Claude credential comes from. S4 replaces it with named credentials. */
export function resolveClaudeToken(config: Config): string | undefined {
  return config.claudeToken;
}

/** The complete child env. S4 extends this with credentials and secrets. */
export function buildAgentEnv(
  serverEnv: NodeJS.ProcessEnv,
  extra: { configDir: string; token: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = serverEnv[k];
    if (v) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = extra.configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = extra.token;
  return env;
}

export function buildRuntimeSpec(
  agent: { id: string; slug: string },
  config: Config,
  token: string,
  serverEnv: NodeJS.ProcessEnv = process.env,
): AgentRuntimeSpec {
  return {
    agentId: agent.id,
    slug: agent.slug,
    cwd: agentWorkdir(config, agent.slug),
    env: buildAgentEnv(serverEnv, { configDir: agentConfigDir(config, agent.slug), token }),
    claudeBin: config.claudeBin,
    ...(config.devModel ? { model: config.devModel } : {}),
    permissionMode: "auto",
  };
}
