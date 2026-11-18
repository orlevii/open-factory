import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface CliConfig {
  url?: string;
  token?: string;
}
type Env = Record<string, string | undefined>;

export const DEFAULT_URL = "http://localhost:3000";

/** `${XDG_CONFIG_HOME:-~/.config}/open-factory/cli.json` */
export const configPath = (env: Env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "open-factory", "cli.json");

const configSchema = z.object({ url: z.string().optional(), token: z.string().optional() });

/** A missing, unparsable or wrongly shaped file reads as `{}`; other read errors (EACCES…) throw. */
export async function readConfig(env: Env): Promise<CliConfig> {
  let text: string;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = configSchema.safeParse(data);
  return parsed.success ? parsed.data : {};
}

/**
 * Writes the config atomically (temp file created 0600 in the same 0700 dir, then renamed over
 * cli.json), so a crash never leaves a partial file and the token is never world-readable.
 */
export async function writeConfig(env: Env, c: CliConfig): Promise<void> {
  const file = configPath(env);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** OPEN_FACTORY_URL / OPEN_FACTORY_TOKEN win, then the config file, then the default URL. */
export function resolveTarget(
  env: Env,
  cfg: CliConfig,
): { url: string; token: string | undefined } {
  return {
    url: (env.OPEN_FACTORY_URL || cfg.url || DEFAULT_URL).replace(/\/$/, ""),
    token: env.OPEN_FACTORY_TOKEN || cfg.token || undefined,
  };
}
