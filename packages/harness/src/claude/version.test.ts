import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { checkClaudeVersion, compareVersions } from "./version.ts";

const fakeBin = (out: string) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "ver-")), "claude");
  writeFileSync(p, `#!/bin/sh\necho '${out}'\n`);
  chmodSync(p, 0o755);
  return p;
};

test("compareVersions", () => {
  expect(compareVersions("2.1.327", "2.1.327")).toBe(0);
  expect(compareVersions("2.1.40", "2.1.327")).toBeLessThan(0);
  expect(compareVersions("2.2.0", "2.1.327")).toBeGreaterThan(0);
});

test("parses `claude --version` and flags old versions", async () => {
  const env = { PATH: process.env.PATH ?? "" };
  expect(await checkClaudeVersion(fakeBin("2.1.327 (Claude Code)"), env)).toEqual({
    version: "2.1.327",
    tooOld: false,
  });
  expect(await checkClaudeVersion(fakeBin("2.1.200 (Claude Code)"), env)).toEqual({
    version: "2.1.200",
    tooOld: true,
  });
  expect(await checkClaudeVersion("/nonexistent/claude", env)).toEqual({ tooOld: false });
});
