import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../styles.css"), "utf8");
const NAMES = ["keyword", "string", "number", "comment", "property", "punctuation", "heading", "link"];

/** The body of the first rule whose header matches, brace-balanced. */
function block(header: RegExp): string {
  const m = header.exec(css);
  if (!m) throw new Error(`no block for ${header}`);
  let depth = 0;
  const start = css.indexOf("{", m.index);
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start + 1, i);
  }
  throw new Error("unbalanced");
}

const blocks: Record<string, string> = {
  light: block(/^:root\s*\{/m),
  dark: block(/^:root\[data-theme="dark"\]\s*\{/m),
  "contrast light": block(/@media \(prefers-contrast: more\)\s*\{\s*:root\s*\{/),
  "contrast dark": block(/@media \(prefers-contrast: more\)\s*\{\s*:root\[data-theme="dark"\]\s*\{/),
};

test.each(Object.entries(blocks))("%s block defines all eight syntax tokens as oklch, never orange", (_n, body) => {
  for (const name of NAMES) {
    const m = new RegExp(`--syntax-${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\);`).exec(body);
    expect(m, `--syntax-${name}`).not.toBeNull();
    const [l, c, h] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(l).toBeGreaterThan(0);
    // Chromatic tokens must stay out of the signal hue band (30-50 degrees).
    if (c > 0.02) expect(h < 30 || h > 50, `--syntax-${name} hue ${h}`).toBe(true);
  }
});
