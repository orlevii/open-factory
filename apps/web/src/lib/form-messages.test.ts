import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { FORM_MSG } from "./form-messages.ts";

const root = path.join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

test("every form message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(FORM_MSG)) expect(m.length, k).toBeLessThanOrEqual(40);
});

test("no field message is a template literal passed to f.set", () => {
  const bad = sources(root).filter((f) => /\.set\([^,]+,\s*`/.test(readFileSync(f, "utf8")));
  expect(bad.map((f) => path.relative(root, f))).toEqual([]);
});
