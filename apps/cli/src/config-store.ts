import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  url?: string;
  token?: string;
}
type Env = Record<string, string | undefined>;

export const DEFAULT_URL = "http://localhost:3000";

/** `${XDG_CONFIG_HOME:-~/.config}/open-factory/cli.json` */
export const configPath = (env: Env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "open-factory", "cli.json");

export async function readConfig(env: Env): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(configPath(env), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Writes the config with mode 0600 in a 0700 directory (chmod also tightens pre-existing ones). */
export async function writeConfig(env: Env, c: CliConfig): Promise<void> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
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
