import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// __dirname, not import.meta.url: jsdom serves the latter over http.
const SRC = join(__dirname, "..");
const css = readFileSync(join(SRC, "styles.css"), "utf8");

export function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".gen.ts")
      ? [p]
      : [];
  });
}

describe("styles.css", () => {
  test("the loading mark animates only when motion is allowed", () => {
    const gate = css.match(
      /@media \(prefers-reduced-motion: no-preference\)\s*{[^}]*\.of-ignite\s*{[^}]*animation:\s*of-ignite/,
    );
    expect(gate).not.toBeNull();
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*?}\s*}/g,
      "",
    );
    expect(outside).not.toMatch(/\.of-ignite\s*{[^}]*animation/);
  });
  test("keyboard-opened overlays never animate", () => {
    expect(css).toMatch(
      /\[data-instant\],\s*\[data-instant\] \*\s*{[^}]*animation:\s*none !important/,
    );
  });
});
