import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class PluginInstallError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "PluginInstallError";
  }
}

export function marketplaceSourceArg(entry: unknown): string {
  const src = (entry as { source?: Record<string, unknown> } | null)?.source;
  const value =
    src?.source === "directory"
      ? src.path
      : src?.source === "git"
        ? src.url
        : src?.source === "github"
          ? src.repo
          : undefined;
  if (typeof value !== "string")
    throw new PluginInstallError("Plugin install failed: unknown marketplace source.", "");
  return value;
}

export function redactOutput(s: string): string {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:access_|refresh_|id_)?token|password|passwd|secret|api[_-]?key)=[^\s&'"]+/gi,
      "$1=[redacted]",
    );
}

/**
 * Runs `claude plugin marketplace add` / `install` on the host (spec §11.7, blocker R1). Claude
 * applies the `env` of its config-dir and project settings to the git it runs, so the host never
 * points it at anything an agent can write: `pluginsConfig` is the factory-owned
 * `state/agents/<slug>/plugins-config/`, the cwd is a fresh empty temp dir (removed afterwards), and
 * the env is exactly `PATH`, the host `HOME` (operator-controlled; git needs its config and
 * credential helpers for private marketplaces) and `CLAUDE_CONFIG_DIR`.
 */
export async function installPlugins(o: {
  claudeBin: string;
  pluginsConfig: string;
  plugins: string[];
  tplSettings: Record<string, unknown>;
  hostHome: string | undefined;
  path: string | undefined;
  commandTimeoutMs?: number;
  budgetMs?: number;
}): Promise<void> {
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: o.pluginsConfig };
  if (o.path) env.PATH = o.path;
  if (o.hostHome) env.HOME = o.hostHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "of-plugins-"));
  try {
    await runInstall(o, env, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function runInstall(
  o: Parameters<typeof installPlugins>[0],
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  const children = new Set<ReturnType<typeof execFile>>();
  let over = false;

  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      if (over)
        return reject(new PluginInstallError("Plugin install took longer than 4 minutes.", ""));
      for (const a of args) {
        if (a.startsWith("-"))
          return reject(new PluginInstallError("Plugin install failed: invalid argument.", ""));
      }
      const child = execFile(
        o.claudeBin,
        ["plugin", ...args],
        { env, cwd, timeout: o.commandTimeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          children.delete(child);
          if (!err) return resolve();
          const lines = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim());
          const errLines = String(stderr)
            .split("\n")
            .filter((l) => l.trim());
          const timedOut = (err as { killed?: boolean }).killed === true;
          const first = timedOut
            ? `${args[0]} ${args[1] ?? ""} timed out after ${(o.commandTimeoutMs ?? 120_000) / 1000} s`
            : (errLines[0] ?? (err as Error).message);
          reject(
            new PluginInstallError(
              `Plugin install failed: ${redactOutput(first)}`,
              redactOutput(lines.slice(-20).join("\n")),
            ),
          );
        },
      );
      children.add(child);
    });

  const sequence = async () => {
    const markets = new Set(o.plugins.map((p) => p.slice(p.lastIndexOf("@") + 1)).filter((m) => m));
    const known = (o.tplSettings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
    for (const m of markets) await run(["marketplace", "add", marketplaceSourceArg(known[m])]);
    for (const p of o.plugins) await run(["install", p]);
  };

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      over = true;
      for (const c of children) c.kill("SIGKILL");
      reject(new PluginInstallError("Plugin install took longer than 4 minutes.", ""));
    }, o.budgetMs ?? 240_000);
  });
  try {
    await Promise.race([sequence(), budget]);
  } finally {
    clearTimeout(timer);
    budget.catch(() => {});
  }
}
