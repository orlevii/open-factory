import { execFile } from "node:child_process";

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
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1[redacted]@")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

export async function installPlugins(o: {
  claudeBin: string;
  configDir: string;
  cwd: string;
  plugins: string[];
  tplSettings: Record<string, unknown>;
  serverEnv: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  budgetMs?: number;
}): Promise<void> {
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: o.configDir };
  if (o.serverEnv.PATH) env.PATH = o.serverEnv.PATH;
  if (o.serverEnv.HOME) env.HOME = o.serverEnv.HOME;
  const children = new Set<ReturnType<typeof execFile>>();
  let over = false;

  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      if (over)
        return reject(new PluginInstallError("Plugin install took longer than 4 minutes.", ""));
      const child = execFile(
        o.claudeBin,
        ["plugin", ...args],
        { env, cwd: o.cwd, timeout: o.commandTimeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          children.delete(child);
          if (!err) return resolve();
          const lines = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim());
          const errLines = String(stderr)
            .split("\n")
            .filter((l) => l.trim());
          const first = errLines[0] ?? (err as Error).message;
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
    const markets = new Set(o.plugins.map((p) => p.split("@")[1]).filter((m): m is string => !!m));
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
