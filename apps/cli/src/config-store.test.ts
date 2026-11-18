import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { configPath, readConfig, resolveTarget, writeConfig } from "./config-store.ts";

test("XDG path, 0600 file, 0700 dir, round trip", async () => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "of-xdg-"));
  const env = { XDG_CONFIG_HOME: xdg };
  expect(configPath(env)).toBe(path.join(xdg, "open-factory", "cli.json"));
  expect(await readConfig(env)).toEqual({});
  await writeConfig(env, { url: "http://h:1", token: "t" });
  expect(await readConfig(env)).toEqual({ url: "http://h:1", token: "t" });
  expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(configPath(env))).mode & 0o777).toBe(0o700);
});

test("defaults to ~/.config without XDG_CONFIG_HOME", () => {
  expect(configPath({})).toBe(path.join(os.homedir(), ".config", "open-factory", "cli.json"));
});

test("env overrides win over the file", () => {
  expect(
    resolveTarget(
      { OPEN_FACTORY_URL: "http://e", OPEN_FACTORY_TOKEN: "et" },
      { url: "http://f", token: "ft" },
    ),
  ).toEqual({ url: "http://e", token: "et" });
  expect(resolveTarget({}, { url: "http://f/", token: "ft" })).toEqual({
    url: "http://f",
    token: "ft",
  });
  expect(resolveTarget({}, {})).toEqual({ url: "http://localhost:3000", token: undefined });
});
