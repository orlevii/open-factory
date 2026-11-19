import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { expect, test } from "vitest";
import {
  installPlugins,
  marketplaceSourceArg,
  PluginInstallError,
  redactOutput,
} from "./plugins.ts";

const tplSettings = {
  extraKnownMarketplaces: { mk: { source: { source: "directory", path: "/x/mk" } } },
};
test("adds marketplaces then installs, with a minimal env", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await installPlugins({
    claudeBin: fake.bin,
    configDir: cfg,
    cwd: cfg,
    plugins: ["p@mk"],
    tplSettings,
    serverEnv: { PATH: process.env.PATH, HOME: "/h", DATABASE_URL: "x" },
  });
  const s = JSON.parse(readFileSync(path.join(cfg, "settings.json"), "utf8"));
  expect(s.enabledPlugins).toEqual({ "p@mk": true });
  const log = readFileSync(path.join(fake.dir, "plugin.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(log.map((l) => l.argv.slice(0, 3))).toEqual([
    ["plugin", "marketplace", "add"],
    ["plugin", "install", "p@mk"],
  ]);
  for (const l of log) expect(l.env).not.toContain("DATABASE_URL");
});
test("failure carries redacted output; budget enforced", async () => {
  const fake = createFakeClaude({ scenario: "reply", env: { FAKE_CLAUDE_PLUGIN_FAIL: "p@mk" } });
  const cfg = mkdtempSync(path.join(tmpdir(), "cfg-"));
  await expect(
    installPlugins({
      claudeBin: fake.bin,
      configDir: cfg,
      cwd: cfg,
      plugins: ["p@mk"],
      tplSettings,
      serverEnv: process.env,
    }),
  ).rejects.toBeInstanceOf(PluginInstallError);
  const slow = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_PLUGIN_SLEEP_MS: "2000" },
  });
  await expect(
    installPlugins({
      claudeBin: slow.bin,
      configDir: cfg,
      cwd: cfg,
      plugins: ["p@mk"],
      tplSettings,
      serverEnv: process.env,
      budgetMs: 300,
    }),
  ).rejects.toThrow("Plugin install took longer than 4 minutes.");
});
test("source args and redaction", () => {
  expect(marketplaceSourceArg({ source: { source: "git", url: "https://h/r.git" } })).toBe(
    "https://h/r.git",
  );
  expect(marketplaceSourceArg({ source: { source: "github", repo: "o/r" } })).toBe("o/r");
  expect(redactOutput("clone https://user:pw@host/x sk-ant-oat01-abc")).toBe(
    "clone https://[redacted]@host/x [redacted]",
  );
});
