import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { FIELD_MSG } from "./field-messages.ts";

const root = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

test("every server field message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(FIELD_MSG)) expect(m.length, k).toBeLessThanOrEqual(40);
});

test("no FieldError takes a template literal as its message", () => {
  const bad = sources(root).filter((f) =>
    /new FieldError\([^,]+,\s*`/.test(readFileSync(f, "utf8")),
  );
  expect(bad.map((f) => path.relative(root, f))).toEqual([]);
});

test("verify.ts messages come from FIELD_MSG", () => {
  const src = readFileSync(path.join(root, "credentials/verify.ts"), "utf8");
  for (const k of ["tokenRejected", "apiKeyRejected", "claudeUnreachable"])
    expect(src).toContain(`FIELD_MSG.${k}`);
  expect(src).not.toMatch(/message:\s*"/);
});
