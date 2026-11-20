import { execFile } from "node:child_process";

export const MIN_CLAUDE_VERSION = "2.1.327";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Runs `<bin> --version` (5 s timeout). Never throws; a missing binary yields `{ tooOld: false }`. */
export function checkClaudeVersion(
  bin: string,
  env: Record<string, string>,
): Promise<{ version?: string; tooOld: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env, timeout: 5000 }, (err, stdout) => {
      const version = err ? undefined : /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1];
      resolve(
        version
          ? { version, tooOld: compareVersions(version, MIN_CLAUDE_VERSION) < 0 }
          : { tooOld: false },
      );
    });
  });
}
