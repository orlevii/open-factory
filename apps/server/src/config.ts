import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factoryZoneDefault, zoneSchema } from "@open-factory/shared";
import { z } from "zod";
import { expandHome } from "./host-path.ts";

export const PLACEHOLDER_SECRET = "change-me-to-a-random-string-of-32-chars-or-more";

export interface Config {
  databaseUrl: string;
  secretKey: string;
  factoryHome: string;
  publicUrl: string;
  publicOrigin: string;
  devWebOrigin: string;
  port: number;
  host: string;
  logLevel: string;
  isProduction: boolean;
  claudeBin: string;
  /** `FACTORY_HOST_CLAUDE_DIR` resolved: the Claude folder; skills are read from `<dir>/skills` (see `hostSkillsDirOf`). */
  hostClaudeDir: string;
  /** `FACTORY_GITHUB_URL`: the GitHub base for Library adds; tests and the evidence pass point it at a fixture. */
  githubUrl: string;
  allowLocalRuntime: boolean;
  defaultImage: string;
  dockerClaudeBin: string;
  cliBundle: string;
  agentUrl: string;
  agentPort: number;
  /** `FACTORY_AGENT_HOST`: replaces the default bind list when set. */
  agentHosts: string[] | undefined;
  /** `FACTORY_TIMEZONE` (S9): the zone agent-created schedules default to, named in the generated CLAUDE.md. */
  factoryTimezone: string;
}

/** Shown wherever the gate is off (validator warning, live status, Restart's 409). */
export const LOCAL_RUNTIME_DISABLED = "The local runtime is disabled on this factory.";
/** The start failure: the same gate, with the fix. */
export const LOCAL_RUNTIME_START_MESSAGE = `${LOCAL_RUNTIME_DISABLED} Set FACTORY_ALLOW_LOCAL_RUNTIME=true to run agents unsandboxed.`;

const DEFAULT_CLI_BUNDLE = fileURLToPath(
  new URL("../../../apps/cli/dist/open-factory.js", import.meta.url),
);

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const httpUrl = z.url({ protocol: /^https?$/, message: "must be an http(s) URL" });

const envSchema = z.object({
  DATABASE_URL: z.string({ message: "is required" }).min(1, "is required"),
  FACTORY_SECRET_KEY: z
    .string({ message: "is required" })
    .min(32, "must be at least 32 characters")
    .refine(
      (v) => v !== PLACEHOLDER_SECRET,
      "is still the .env.example placeholder; generate one with `openssl rand -base64 32`",
    ),
  FACTORY_HOME: z.string().min(1).default("~/open-factory"),
  PUBLIC_URL: httpUrl.optional(),
  DEV_WEB_ORIGIN: httpUrl.default("http://localhost:5173"),
  PORT: z.coerce.number({ message: "must be a port number" }).int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().optional(),
  FACTORY_CLAUDE_BIN: z.string().min(1).default("claude"),
  FACTORY_HOST_CLAUDE_DIR: z.string().min(1).default("~/.claude"),
  FACTORY_GITHUB_URL: z
    .url({ protocol: /^(https?|file)$/, message: "must be an http(s) or file URL" })
    .refine((u) => {
      const { username, password } = new URL(u);
      return !username && !password;
    }, "must not contain a username or password")
    .default("https://github.com"),
  FACTORY_ALLOW_LOCAL_RUNTIME: z.enum(["true", "false"]).default("false"),
  FACTORY_DEFAULT_IMAGE: z.string().min(1).default("ghcr.io/orlevii/open-factory/base:latest"),
  FACTORY_DOCKER_CLAUDE_BIN: z.string().min(1).default("claude"),
  FACTORY_CLI_BUNDLE: z.string().min(1).default(DEFAULT_CLI_BUNDLE),
  FACTORY_AGENT_URL: httpUrl.optional(),
  FACTORY_AGENT_PORT: z.coerce
    .number({ message: "must be a port number" })
    .int()
    .min(0)
    .max(65535)
    .optional(),
  FACTORY_AGENT_HOST: z.string().optional(),
  FACTORY_TIMEZONE: zoneSchema.optional(),
});

/** Where host skills are read from: `<FACTORY_HOST_CLAUDE_DIR>/skills` (I5 §5.2). */
export function hostSkillsDirOf(c: Pick<Config, "hostClaudeDir">): string {
  return path.join(c.hostClaudeDir, "skills");
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // `PORT=` in .env or the shell means "not set", not "port 0".
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`));
  }
  const e = parsed.data;
  const publicUrl = (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, "");
  const agentPort = e.FACTORY_AGENT_PORT ?? e.PORT + 1;
  const issues: string[] = [];
  if (agentPort !== 0 && agentPort === e.PORT) {
    issues.push(
      "FACTORY_AGENT_PORT must differ from PORT (the agent listener is a separate server); set another port, or 0 for any free one",
    );
  }
  if (agentPort > 65535) {
    issues.push(
      "FACTORY_AGENT_PORT defaults to PORT + 1, which is above 65535; set FACTORY_AGENT_PORT",
    );
  }
  const agentHosts = e.FACTORY_AGENT_HOST?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (const h of agentHosts ?? []) {
    if (!isIP(h)) {
      issues.push(
        `FACTORY_AGENT_HOST entry "${h}" must be an IP address (hostnames can't be matched to a source range)`,
      );
    }
  }
  if (issues.length) throw new ConfigError(issues);
  return {
    databaseUrl: e.DATABASE_URL,
    secretKey: e.FACTORY_SECRET_KEY,
    factoryHome: path.resolve(expandHome(e.FACTORY_HOME)),
    publicUrl,
    publicOrigin: new URL(publicUrl).origin,
    devWebOrigin: new URL(e.DEV_WEB_ORIGIN).origin,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    isProduction: e.NODE_ENV === "production",
    claudeBin: e.FACTORY_CLAUDE_BIN,
    hostClaudeDir: path.resolve(expandHome(e.FACTORY_HOST_CLAUDE_DIR)),
    githubUrl: e.FACTORY_GITHUB_URL.replace(/\/$/, ""),
    allowLocalRuntime: e.FACTORY_ALLOW_LOCAL_RUNTIME === "true",
    defaultImage: e.FACTORY_DEFAULT_IMAGE,
    dockerClaudeBin: e.FACTORY_DOCKER_CLAUDE_BIN,
    cliBundle: path.resolve(e.FACTORY_CLI_BUNDLE),
    agentUrl: (e.FACTORY_AGENT_URL ?? `http://host.docker.internal:${agentPort}`).replace(
      /\/$/,
      "",
    ),
    agentPort,
    agentHosts: agentHosts?.length ? agentHosts : undefined,
    factoryTimezone: e.FACTORY_TIMEZONE ?? factoryZoneDefault(),
  };
}
