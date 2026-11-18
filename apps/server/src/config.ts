import os from "node:os";
import path from "node:path";
import { z } from "zod";

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
}

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
});

function expandHome(p: string): string {
  return path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
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
  return {
    databaseUrl: e.DATABASE_URL,
    secretKey: e.FACTORY_SECRET_KEY,
    factoryHome: expandHome(e.FACTORY_HOME),
    publicUrl,
    publicOrigin: new URL(publicUrl).origin,
    devWebOrigin: new URL(e.DEV_WEB_ORIGIN).origin,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    isProduction: e.NODE_ENV === "production",
  };
}
