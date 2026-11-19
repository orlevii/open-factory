import type { AgentRuntimeSpec, Mount } from "@open-factory/harness";
import type { TemplateConfig } from "@open-factory/shared";

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

/** The complete child env: the allowlist, plus what the factory sets for this agent. */
export function buildAgentEnv(
  serverEnv: NodeJS.ProcessEnv,
  extra: {
    configDir: string;
    slug: string;
    credential: { kind: "oauth_token" | "api_key"; value: string };
    secrets: Record<string, string>;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = serverEnv[k];
    if (v) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = extra.configDir;
  env[extra.credential.kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"] =
    extra.credential.value;
  for (const [k, v] of Object.entries(extra.secrets)) env[k] = v;
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = extra.slug;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${extra.slug}@open-factory.local`;
  return env;
}

export function buildRuntimeSpec(i: {
  agentId: string;
  slug: string;
  workdir: string;
  env: Record<string, string>;
  claudeBin: string;
  config: TemplateConfig;
  mounts: Mount[];
}): AgentRuntimeSpec {
  return {
    agentId: i.agentId,
    slug: i.slug,
    cwd: i.workdir,
    env: i.env,
    claudeBin: i.claudeBin,
    runtime: i.config.runtime,
    ...(i.config.model ? { model: i.config.model } : {}),
    ...(i.config.effort ? { effort: i.config.effort } : {}),
    permissionMode: i.config.permissionMode,
    mounts: i.mounts,
  };
}
