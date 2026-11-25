import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRow, MarketplaceRow } from "@open-factory/db";
import type { ConfigDoc } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { ApiError } from "../errors.ts";
import { hostOnlyLibrary } from "../test/library.ts";
import { ConfigResolver, configOf } from "./config-resolver.ts";
import { AgentStartError, forSpawnedAgent } from "./errors.ts";

const baseDoc = (): ConfigDoc => ({
  template: {
    name: "dev",
    display_name: "Dev",
    runtime: "docker",
    skills: ["grilling"],
    secrets: ["GH_TOKEN"],
    max_live_spawns: 2,
  },
  settings: { permissions: { deny: ["Bash(curl:*)"] } },
  mcp: { mcpServers: { a: { command: "secret-cmd", args: ["--token", "s3cr3t"] } } },
});

// One registered marketplace, `acme`, read at COMMIT (and the tag v1 at TAG_COMMIT), and a folder marketplace.
const COMMIT = "a".repeat(40);
const TAG_COMMIT = "b".repeat(40);
const home = mkdtempSync(path.join(tmpdir(), "of-resolver-"));
const catalog = {
  name: "acme",
  plugins: [
    { name: "rel", source: "./plugins/rel" },
    { name: "dep", source: "./plugins/dep" },
  ],
};
const writeMarketplace = (dir: string) => {
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog));
  mkdirSync(path.join(dir, "plugins", "rel", ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugins", "rel", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "rel", dependencies: ["dep"] }),
  );
  mkdirSync(path.join(dir, "plugins", "dep", ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugins", "dep", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "dep" }),
  );
};
const folder = mkdtempSync(path.join(tmpdir(), "of-resolver-mk-"));
writeMarketplace(folder);
for (const sha of [COMMIT, TAG_COMMIT])
  writeMarketplace(path.join(home, "state", "library", "marketplaces", "acme", sha));
const marketplaceRow = (name: string, source: MarketplaceRow["source"]): MarketplaceRow => ({
  name,
  source,
  branch: "main",
  commit: source.source === "directory" ? null : COMMIT,
  committedAt: null,
  subject: null,
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  tags: { v1: TAG_COMMIT },
  state: "ready",
  startedAt: new Date(0),
  addedBy: "@or",
  addedAt: new Date(0),
  deletedAt: null,
});
const registered = hostOnlyLibrary(
  home,
  home,
  [],
  [
    marketplaceRow("acme", { source: "github", repo: "o/acme" }),
    marketplaceRow("local", { source: "directory", path: folder }),
  ],
);

const stubLibrary = {
  marketplaces: () => registered.marketplaces(),
  marketplaceDir: registered.marketplaceDir.bind(registered),
  catalogAt: registered.catalogAt.bind(registered),
  resolveSkill: async (name: string) =>
    name === "tdd"
      ? { ok: true as const, name, dir: "/x/tdd", ref: "github:abc" }
      : { ok: false as const, reason: "not_added" as const },
};

type Fake = { loadValid: (name: string) => Promise<{ doc: ConfigDoc }> };
const resolverWith = (load: Fake["loadValid"]) =>
  new ConfigResolver({ templates: { loadValid: load } as never, library: stubLibrary });
const resolverFor = (doc: ConfigDoc = baseDoc()) => resolverWith(async () => ({ doc }));

const agent = (over: Omit<Partial<AgentRow>, "config"> & { config?: unknown } = {}): AgentRow =>
  ({
    id: "a1",
    slug: "ana",
    template: "dev",
    kind: "persistent",
    runtime: "local",
    config: {},
    ...over,
  }) as AgentRow;

describe("configOf", () => {
  test("parses a doc carrying the derived local_skill_names (I2 §7.2), which the strict yaml schema would refuse", () => {
    const doc = baseDoc();
    doc.template.local_skill_names = ["release"];
    expect(configOf(doc, "local")).toMatchObject({
      name: "dev",
      runtime: "local",
      skills: ["grilling"],
    });
    expect(configOf({ ...doc, template: { ...doc.template, bogus: 1 } }, "local")).toBeUndefined();
  });
});

describe("ConfigResolver.effective", () => {
  test("an empty overlay is exactly the template", async () => {
    const e = await resolverFor().effective(agent());
    expect(e.doc).toEqual(baseDoc());
    expect(e.config.skills).toEqual(["grilling"]);
    expect(e.config.maxLiveSpawns).toBe(2);
  });

  test("records the Library's ref of each listed skill, and missing for one that doesn't resolve", async () => {
    const doc = baseDoc();
    doc.template.skills = ["tdd", "grilling"];
    const e = await resolverFor(doc).effective(agent());
    expect(e.library).toEqual({ skills: { tdd: "github:abc", grilling: "missing" }, plugins: {} });
  });

  const withPlugins = (decl: unknown, plugins: Record<string, true>, mkt = "acme"): ConfigDoc => ({
    ...baseDoc(),
    settings: { extraKnownMarketplaces: { [mkt]: decl }, enabledPlugins: plugins },
  });
  const github = { source: "github", repo: "o/acme" };

  test.each([
    ["a commit", { ref: COMMIT }, `commit:${COMMIT}`],
    ["a tag", { ref: "v1" }, "tag:v1"],
    ["no ref (Latest)", {}, "latest"],
  ])("a plugin's pin is its declaration's: %s", async (_n, ref, pin) => {
    const doc = withPlugins({ source: { ...github, ...ref } }, { "x@acme": true });
    const e = await resolverFor(doc).effective(agent());
    expect(e.library.plugins).toEqual({ "x@acme": pin });
  });

  test("a folder marketplace's plugins are live", async () => {
    const doc = withPlugins(
      { source: { source: "directory", path: folder } },
      { "x@local": true },
      "local",
    );
    expect((await resolverFor(doc).effective(agent())).library.plugins).toEqual({
      "x@local": "live",
    });
  });

  test("the dependencies of a plugin are read from the checkout at its pin and share it", async () => {
    const doc = withPlugins({ source: { ...github, ref: "v1" } }, { "rel@acme": true });
    expect((await resolverFor(doc).effective(agent())).library.plugins).toEqual({
      "rel@acme": "tag:v1",
      "dep@acme": "tag:v1",
    });
  });

  test("a plugin from a marketplace the doc doesn't declare is missing, and a disabled one isn't listed", async () => {
    const doc = withPlugins({ source: github }, { "x@elsewhere": true });
    doc.settings.enabledPlugins = { "x@elsewhere": true, "off@acme": false };
    expect((await resolverFor(doc).effective(agent())).library.plugins).toEqual({
      "x@elsewhere": "missing",
    });
  });

  test("merges the overlay into the template, settings and mcp", async () => {
    const e = await resolverFor().effective(
      agent({
        config: {
          template: { skills: ["review"], model: "opus", secrets: ["NPM_TOKEN"] },
          settings: { permissions: { deny: ["Bash(rm:*)"] } },
          mcp: { mcpServers: { b: { command: "x" } } },
        },
      }),
    );
    expect(e.config.skills).toEqual(["grilling", "review"]);
    expect(e.config.secrets).toEqual(["GH_TOKEN", "NPM_TOKEN"]);
    expect(e.config.model).toBe("opus");
    expect(e.doc.settings).toEqual({ permissions: { deny: ["Bash(curl:*)", "Bash(rm:*)"] } });
    expect(Object.keys(e.doc.mcp.mcpServers)).toEqual(["a", "b"]);
  });

  test("runtime is overwritten from the row", async () => {
    const e = await resolverFor().effective(agent({ runtime: "local" }));
    expect(e.config.runtime).toBe("local");
    expect(e.doc.template.runtime).toBe("docker");
  });

  test("a spawned agent ignores its config", async () => {
    const e = await resolverFor().effective(
      agent({ kind: "ephemeral", config: { template: { skills: ["review"] }, bogus: 1 } }),
    );
    expect(e.doc).toEqual(baseDoc());
    expect(e.config.skills).toEqual(["grilling"]);
  });

  test("a missing template has no fix", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(409, "template_missing", "Template dev no longer exists.");
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("Template dev no longer exists.");
    expect(err.fix).toBeUndefined();
  });

  test("a template name that isn't found reads as missing", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(404, "template_not_found", "Template dev not found.");
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err.message).toBe("Template dev no longer exists.");
    expect(err.fix).toBeUndefined();
  });

  test("an invalid template fixes in Templates", async () => {
    const r = resolverWith(async () => {
      throw new ApiError(409, "template_invalid", "Template dev has errors.", { issues: [] });
    });
    const err = await r.effective(agent()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("Template dev has errors. Fix it in Templates.");
    expect(err.fix).toBe("template");
  });

  test("an invalid overlay fixes in Configuration and never prints a value", async () => {
    const err = await resolverFor()
      .effective(agent({ config: { template: { model: "-bad" }, leaked: "s3cr3t-value" } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toBe("The configuration of @ana is invalid. Fix it in Configuration.");
    expect(err.fix).toBe("config");
    expect(JSON.stringify(err.message)).not.toContain("s3cr3t");
  });

  test("an overlay that breaks the merged template is invalid", async () => {
    const err = await resolverFor()
      .effective(agent({ config: { template: { max_live_spawns: 999 } } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.fix).toBe("config");
  });

  test("other errors pass through", async () => {
    const r = resolverWith(async () => {
      throw new Error("disk");
    });
    await expect(r.effective(agent())).rejects.toThrow("disk");
  });

  test("a spawned agent's overlay error drops the fix and its advice", async () => {
    const err = new AgentStartError(
      "The configuration of @ana is invalid. Fix it in Configuration.",
      "config",
      "The configuration of @ana is invalid.",
    );
    const spawned = forSpawnedAgent(err);
    expect(spawned.fix).toBeUndefined();
    expect(spawned.message).toBe(
      "The configuration of @ana is invalid. Terminate it and spawn a new one.",
    );
  });
});
