import type { AgentRuntimeSpec, Mount } from "@open-factory/harness";
import { isFactoryEnvName, type TemplateConfig } from "@open-factory/shared";

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
    agentUrl?: string;
    agentToken: string;
  },
  runtime: "local" | "docker",
): Record<string, string> {
  // Secrets go in first so nothing a user names a secret can override what the factory sets below.
  const env: Record<string, string> = { ...extra.secrets };
  // A container gets none of the host's env: the image supplies its own PATH and HOME.
  for (const k of ENV_ALLOWLIST) {
    const v = runtime === "local" ? serverEnv[k] : undefined;
    if (v) env[k] = v;
    else delete env[k];
  }
  env.CLAUDE_CONFIG_DIR = extra.configDir;
  const [credVar, otherVar] =
    extra.credential.kind === "api_key"
      ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  env[credVar as string] = extra.credential.value;
  delete env[otherVar as string]; // exactly one credential var, whatever a secret is called
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = extra.slug;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${extra.slug}@open-factory.local`;
  if (runtime === "docker") {
    delete env.OPEN_FACTORY_URL;
    if (extra.agentUrl) env.OPEN_FACTORY_URL = extra.agentUrl;
  }
  // Last, so no secret can override it. Never log it.
  env.OPEN_FACTORY_AGENT_TOKEN = extra.agentToken;
  // The list in shared is what overlays and templates may never set; it must name everything set here.
  for (const k of Object.keys(env))
    if (
      !(extra.secrets && k in extra.secrets) &&
      !(ENV_ALLOWLIST as readonly string[]).includes(k) &&
      !isFactoryEnvName(k)
    )
      throw new Error(`buildAgentEnv set ${k}, which is not in FACTORY_ENV_NAMES.`);
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
