import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// __dirname, not import.meta.url: jsdom serves the latter over http.
export const SRC = join(__dirname, "..");

export function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".gen.ts")
      ? [p]
      : [];
  });
}
