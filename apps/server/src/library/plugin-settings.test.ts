import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildPluginSettings,
  dependencyKeys,
  type MarketplaceSource,
  readInstalled,
  readManifest,
} from "./plugin-settings.ts";

const github: MarketplaceSource = { source: "github", repo: "o/acme" };
const SHA = "a".repeat(40);

const settings = (over: Partial<Parameters<typeof buildPluginSettings>[0]> = {}) =>
  buildPluginSettings({
    closure: ["p@acme"],
    declarations: { acme: { source: github, pin: { kind: "commit", sha: SHA } } },
    catalogs: { acme: ["p", "q", "dep"] },
    installed: [],
    skillsDirNames: [],
    ...over,
  });

describe("buildPluginSettings", () => {
  test("true for the closure, including readable dependencies", () => {
    const s = settings({ closure: ["p@acme", "dep@acme"] });
    expect(s.enabledPlugins["p@acme"]).toBe(true);
    expect(s.enabledPlugins["dep@acme"]).toBe(true);
  });

  test("a dependency from an undeclared marketplace is false, never true", () => {
    // The closure never holds it (the workspace leaves it out); an installed manifest naming it only lists it as installed.
    const s = settings({ installed: ["p@acme", "evil@nowhere"] });
    expect(s.enabledPlugins["evil@nowhere"]).toBe(false);
    expect(s.enabledPlugins["p@acme"]).toBe(true);
  });

  test("false for the other catalog plugins, installed keys outside the closure and skills-directory names", () => {
    const s = settings({ installed: ["mine@elsewhere", "p@acme"], skillsDirNames: ["grilling"] });
    expect(s.enabledPlugins).toEqual({
      "p@acme": true,
      "q@acme": false,
      "dep@acme": false,
      "mine@elsewhere": false,
      "grilling@skills-dir": false,
    });
  });

  test("a commit pin carries ref and autoUpdate false; a tag does too", () => {
    expect(settings().extraKnownMarketplaces).toEqual({
      acme: { source: { source: "github", repo: "o/acme", ref: SHA }, autoUpdate: false },
    });
    const tag = settings({
      declarations: { acme: { source: github, pin: { kind: "tag", name: "v1.2" } } },
    });
    expect(tag.extraKnownMarketplaces.acme).toEqual({
      source: { source: "github", repo: "o/acme", ref: "v1.2" },
      autoUpdate: false,
    });
  });

  test("Latest has no ref and autoUpdate true", () => {
    const s = settings({ declarations: { acme: { source: github, pin: { kind: "latest" } } } });
    expect(s.extraKnownMarketplaces.acme).toEqual({ source: github, autoUpdate: true });
    expect(s.extraKnownMarketplaces.acme?.source).not.toHaveProperty("ref");
  });

  test("a live folder has no ref and no auto-update", () => {
    const dir: MarketplaceSource = { source: "directory", path: "/mk" };
    const s = settings({ declarations: { acme: { source: dir, pin: { kind: "live" } } } });
    expect(s.extraKnownMarketplaces.acme).toEqual({ source: dir, autoUpdate: false });
  });

  test("only the given declarations are set (the template's own are never carried over), and sync is off", () => {
    const s = settings();
    expect(Object.keys(s.extraKnownMarketplaces)).toEqual(["acme"]);
    expect(s.syncClaudeAiPlugins).toBe(false);
  });
});

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), "of-installed-")));
const manifest = (dir: string, body: unknown) => {
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(body));
};
const installedList = (root: string, plugins: Record<string, unknown>) =>
  writeFileSync(path.join(root, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));

describe("readInstalled", () => {
  test("reads Claude Code's installed_plugins.json: keys under .plugins and each manifest inside the dir", async () => {
    const root = tmp();
    const p = path.join(root, "cache/acme/p/1.0.0");
    manifest(p, {
      name: "p",
      version: "1.0.0",
      dependencies: ["dep", { name: "x", marketplace: "other" }],
    });
    installedList(root, {
      "p@acme": [{ scope: "user", installPath: p, version: "1.0.0" }],
      "gone@acme": [{ scope: "user", installPath: path.join(root, "cache/acme/gone/1") }],
      "not a key": [{ installPath: p }],
    });
    const got = await readInstalled(root);
    expect(got.map((e) => e.key)).toEqual(["p@acme", "gone@acme"]);
    expect(got[0]?.manifest).toEqual({
      name: "p",
      version: "1.0.0",
      dependencies: [{ name: "dep" }, { name: "x", marketplace: "other" }],
    });
    expect(got[1]?.manifest).toBeUndefined();
    expect(dependencyKeys(got[0]?.manifest ?? { dependencies: [] }, "acme")).toEqual([
      "dep@acme",
      "x@other",
    ]);
  });

  test("a manifest outside the plugins dir, or behind a link, is not read", async () => {
    const root = tmp();
    const outside = tmp();
    manifest(outside, { name: "evil", dependencies: ["z"] });
    const link = path.join(root, "cache-link");
    symlinkSync(outside, link);
    installedList(root, {
      "a@acme": [{ installPath: outside }],
      "b@acme": [{ installPath: link }],
    });
    const got = await readInstalled(root);
    expect(got.map((e) => e.key)).toEqual(["a@acme", "b@acme"]);
    expect(got.every((e) => e.manifest === undefined)).toBe(true);
  });

  test("a missing, linked or oversized list is empty", async () => {
    const root = tmp();
    expect(await readInstalled(root)).toEqual([]);
    const real = path.join(tmp(), "real.json");
    writeFileSync(real, JSON.stringify({ version: 2, plugins: { "a@acme": [] } }));
    symlinkSync(real, path.join(root, "installed_plugins.json"));
    expect(await readInstalled(root)).toEqual([]);
    const big = tmp();
    writeFileSync(
      path.join(big, "installed_plugins.json"),
      `{"plugins":{"a@acme":[],"pad":"${"x".repeat(300 * 1024)}"}}`,
    );
    expect(await readInstalled(big)).toEqual([]);
  });

  test("a manifest over 256 KB is ignored", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, ".claude-plugin"));
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      `{"name":"p","pad":"${"x".repeat(300 * 1024)}"}`,
    );
    expect(await readManifest(dir)).toBeUndefined();
  });
});
