import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigDoc } from "@open-factory/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiError } from "../errors.ts";
import { HostPlugins } from "./host-plugins.ts";
import { MarketplacesService } from "./marketplaces-service.ts";
import type { Declarations } from "./plugin-usage.ts";
import { PluginsIndex } from "./plugins-index.ts";
import { makeAcmeMarketplace } from "./testing/acme-marketplace.ts";
import { makeFixtureRepo } from "./testing/fixture-repo.ts";
import { memoryMarketplacesStore } from "./testing/memory-marketplaces-store.ts";

/** I5 §9.1, §9.3: the Plugins view over real checkouts of fixture repos served over file://. */
let tmp: string;
let fh: string;
let host: string;
let decl: Declarations;
let published: number;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-plugidx-")));
  fh = path.join(tmp, "fh");
  host = path.join(tmp, "claude");
  mkdirSync(fh, { recursive: true });
  mkdirSync(path.join(host, "plugins", "cache"), { recursive: true });
  decl = { templates: new Map(), agents: [] };
  published = 0;
});
afterEach(async () => {
  const open = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        chmodSync(p, 0o755);
        open(p);
      }
    }
  };
  open(tmp);
  await rm(tmp, { recursive: true, force: true });
});

/** The acme marketplace (see `makeAcmeMarketplace`), added to a registry over file://. */
async function world(make: typeof makeAcmeMarketplace = makeAcmeMarketplace) {
  const made = await make(tmp);
  const home = path.join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const store = memoryMarketplacesStore();
  const marketplaces = new MarketplacesService({
    store,
    usedBy: async () => ({ templates: [], agents: [] }),
    factoryHome: fh,
    home,
    forbidden: { home, factoryHome: fh, dockerSockets: [] },
    githubUrl: `file://${tmp}/gh`,
    log: () => {},
  });
  const preview = await marketplaces.preview({ kind: "github", repo: "acme/mk" });
  await marketplaces.add(preview.previewId, "@or");
  const hostPlugins = new HostPlugins({
    hostClaudeDir: host,
    forbidden: { home, factoryHome: fh, dockerSockets: [] },
    registered: async () => (await store.all()).map((r) => r.name),
    marketplaces,
  });
  const index = new PluginsIndex({
    library: {
      marketplaces: async () => (await store.all()).filter((r) => r.deletedAt === null),
      marketplaceDir: async (row, ref) => marketplaces.checkout(row.name, ref),
      declarations: async () => decl,
    },
    marketplaces,
    host: hostPlugins,
    factoryHome: fh,
    githubUrl: `file://${tmp}/gh`,
    publish: () => {
      published++;
    },
    log: () => {},
  });
  return { index, marketplaces, shas: made.repoShas, extSha: made.extSha };
}

const doc = (declared: Record<string, unknown>, enabled: string[]): ConfigDoc => ({
  template: {},
  settings: {
    extraKnownMarketplaces: declared,
    enabledPlugins: Object.fromEntries(enabled.map((k) => [k, true])),
  },
  mcp: { mcpServers: {} },
});

describe("list", () => {
  test("groups the catalog by marketplace at the Library's commit with pinnable, the refusal, the contents summary and the users", async () => {
    const w = await world();
    decl = {
      templates: new Map([
        [
          "dev",
          doc({ acme: { source: { source: "github", repo: "acme/mk", ref: w.shas[0] } } }, [
            "rel@acme",
          ]),
        ],
      ]),
      agents: [{ slug: "ana", template: "dev", config: {} }],
    };
    const r = await w.index.list();
    expect(r.host).toEqual([]);
    expect(r.marketplaces).toHaveLength(1);
    const m = r.marketplaces[0];
    expect(m).toMatchObject({ name: "acme", commit: w.shas[1], state: "ready" });
    const by = Object.fromEntries((m?.plugins ?? []).map((p) => [p.name, p]));
    expect(by.rel).toMatchObject({
      key: "rel@acme",
      version: "1.1.0",
      pinnable: true,
      state: "ok",
      canRead: false,
      usedBy: { templates: [{ name: "dev", pin: `commit:${w.shas[0]}`, agents: 1 }], overlays: [] },
    });
    expect(by.rel?.contentsSummary).toMatchObject({ hooks: 2, needs: 2 });
    // The external plugin is pinned by its sha but not read yet: its contents are a click away.
    expect(by.ext).toMatchObject({
      pinnable: true,
      state: "ok",
      canRead: true,
      contentsSummary: null,
    });
    expect(by.loose).toMatchObject({
      pinnable: false,
      state: "cant_pin",
      refusedReason: "Can't be pinned: it follows its own source.",
      canRead: false,
    });
    expect(by.bad).toMatchObject({
      pinnable: false,
      state: "refused",
      refusedReason: "Plugin bad@acme uses a npm source, which Open Factory doesn't install.",
    });
  });

  test("a registered marketplace's host plugin is left out of the host list, and a peek shows the host version", async () => {
    const w = await world();
    const dir = path.join(host, "plugins", "cache", "acme", "rel", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(host, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "rel@acme": [{ installPath: dir, version: "1.0.0", lastUpdated: "2026-01-01T00:00:00Z" }],
        },
      }),
    );
    expect((await w.index.list()).host).toEqual([]);
    expect((await w.index.detail("rel@acme")).hostVersion).toBe("1.0.0");
  });
});

describe("ranged dependencies (spec §7.4)", () => {
  test("a relative plugin with a ranged dependency is Can't be pinned in the list and the detail; an exact one is pinnable", async () => {
    const w = await world(async (dir) => {
      const manifest = (name: string, dependencies: unknown[]) =>
        JSON.stringify({ name, version: "1.0.0", dependencies });
      const repo = await makeFixtureRepo(path.join(dir, "gh", "acme", "mk.git"), {
        commits: [
          {
            ".claude-plugin/marketplace.json": JSON.stringify({
              name: "acme",
              plugins: [
                { name: "ranged", source: "./plugins/ranged" },
                { name: "exact", source: "./plugins/exact" },
              ],
            }),
            "plugins/ranged/.claude-plugin/plugin.json": manifest("ranged", [
              { name: "exact", version: "^1.0.0" },
            ]),
            "plugins/exact/.claude-plugin/plugin.json": manifest("exact", []),
          },
        ],
      });
      return { repoShas: repo.shas, extSha: "" };
    });
    const m = (await w.index.list()).marketplaces[0];
    const by = Object.fromEntries((m?.plugins ?? []).map((p) => [p.name, p]));
    expect(by.ranged).toMatchObject({
      pinnable: false,
      state: "cant_pin",
      refusedReason: expect.stringContaining("Can't be pinned"),
    });
    expect(by.exact).toMatchObject({ pinnable: true, state: "ok" });
    expect(await w.index.detail("ranged@acme")).toMatchObject({
      pinnable: false,
      state: "cant_pin",
    });
  });
});

describe("detail, file, read and diff", () => {
  test("reads at the Library's commit by default and at a commit Skills has read", async () => {
    const w = await world();
    const now = await w.index.detail("rel@acme");
    expect(now).toMatchObject({
      from: "library",
      commit: w.shas[1],
      version: "1.1.0",
      state: "ok",
    });
    expect(now.contents?.hooks.map((h) => h.command)).toEqual([
      "node $" + "{CLAUDE_PLUGIN_ROOT}/a.js",
      "python3 b.py",
    ]);
    await w.marketplaces.fetchAt("acme", w.shas[0] as string);
    const old = await w.index.detail("rel@acme", { commit: w.shas[0] });
    expect(old).toMatchObject({ commit: w.shas[0], version: "1.0.0" });
    expect(old.contents?.hooks).toHaveLength(1);
  });

  test("a commit Skills hasn't read is a 404 that says so", async () => {
    const w = await world();
    const e = await w.index.detail("rel@acme", { commit: "d".repeat(40) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      status: 404,
      code: "not_read",
      message: "Skills hasn't read acme at ddddddd.",
    });
    await expect(w.index.detail("nope@acme")).rejects.toMatchObject({ status: 404 });
    await expect(w.index.detail("rel@nowhere")).rejects.toMatchObject({ status: 404 });
  });

  test("View file serves only files the hooks and servers reference", async () => {
    const w = await world();
    expect(await w.index.fileText("rel@acme", "a.js")).toBe("console.log('a')\n");
    await expect(w.index.fileText("rel@acme", ".claude-plugin/plugin.json")).rejects.toMatchObject({
      status: 400,
      extra: { fields: { path: expect.any(String) } },
    });
    await expect(w.index.fileText("rel@acme", "../../etc/passwd")).rejects.toMatchObject({
      status: 400,
    });
  });

  test("a relative plugin folder that leaves the marketplace through a link can't be shown", async () => {
    const w = await world();
    // A git checkout has no links (spec §6.2), but a live folder marketplace can: the plugin's folder is confined.
    const outside = path.join(tmp, "outside-plugin");
    mkdirSync(path.join(outside, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(outside, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "esc", version: "9.9.9" }),
    );
    const live = path.join(tmp, "live");
    mkdirSync(path.join(live, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(live, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "live", plugins: [{ name: "esc", source: "./esc" }] }),
    );
    symlinkSync(outside, path.join(live, "esc"));
    const p = await w.marketplaces.preview({ kind: "directory", path: live });
    await w.marketplaces.add(p.previewId, "@or");
    const d = await w.index.detail("esc@live");
    expect(d).toMatchObject({ state: "missing", contents: null });
    expect(d.contentsNote).toBe("Can't show: the plugin's folder is outside the marketplace.");
  });

  test("Read contents fetches an external sha source, once, and publishes", async () => {
    const w = await world();
    const before = await w.index.detail("ext@acme");
    expect(before).toMatchObject({
      contents: null,
      contentsNote: "Contents not read yet",
      canRead: true,
    });
    const read = await w.index.read("ext@acme");
    expect(read).toMatchObject({ canRead: false, contentsNote: null });
    expect(read.contents?.hooks[0]?.command).toBe("uvx ext-tool");
    expect(read.contents?.needs).toEqual(["uvx"]);
    expect(published).toBe(1);
    expect((await w.index.detail("ext@acme")).canRead).toBe(false);
    expect(
      (await w.index.list()).marketplaces[0]?.plugins.find((p) => p.name === "ext")
        ?.contentsSummary,
    ).toMatchObject({ hooks: 1 });
  });

  test("Read contents has nothing to read for a relative plugin", async () => {
    const w = await world();
    await expect(w.index.read("rel@acme")).rejects.toMatchObject({
      status: 409,
      code: "nothing_to_read",
    });
  });

  test("the diff between two commits lists what the newer one adds, and says when a side lacks the plugin", async () => {
    const w = await world();
    await w.marketplaces.fetchAt("acme", w.shas[0] as string);
    const d = await w.index.diff("rel@acme", w.shas[0] as string, w.shas[1] as string);
    expect(d.from).toMatchObject({ commit: w.shas[0], present: true, version: "1.0.0" });
    expect(d.to).toMatchObject({ commit: w.shas[1], present: true, version: "1.1.0" });
    expect(d.diff.hooks.added.map((h) => h.command)).toEqual(["python3 b.py"]);
    expect(d.diff.hooks.removed).toEqual([]);
    expect(d.diff.needs.added).toEqual(["python3"]);
    expect(d.diff.runsCode).toBe(true);
    // Backwards, the same hook is removed.
    const back = await w.index.diff("rel@acme", w.shas[1] as string, w.shas[0] as string);
    expect(back.diff.hooks.removed.map((h) => h.command)).toEqual(["python3 b.py"]);
  });

  test("a diff of an external plugin fetches its source and compares it with nothing for a missing side", async () => {
    const w = await world();
    await w.marketplaces.fetchAt("acme", w.shas[0] as string);
    const d = await w.index.diff("ext@acme", w.shas[0] as string, w.shas[1] as string);
    // Same sha at both commits: nothing changed.
    expect(d.diff.runsCode).toBe(false);
    expect(d.to.present).toBe(true);
    // It fetched the external source into the cache, so open pages are told; a second diff fetches nothing.
    expect(published).toBe(1);
    await w.index.diff("ext@acme", w.shas[0] as string, w.shas[1] as string);
    expect(published).toBe(1);
  });

  test("the host's copy is read with from=host, and listed when its marketplace isn't registered", async () => {
    const w = await world();
    const dir = path.join(host, "plugins", "cache", "zed", "tool", "2.0.0");
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "tool", version: "2.0.0" }),
    );
    writeFileSync(
      path.join(host, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "tool@zed": [{ installPath: dir, version: "2.0.0", lastUpdated: "2026-01-01T00:00:00Z" }],
        },
      }),
    );
    const d = await w.index.detail("tool@zed", { from: "host" });
    expect(d).toMatchObject({
      from: "host",
      commit: null,
      version: "2.0.0",
      hostVersion: "2.0.0",
      source: { kind: "host" },
    });
    expect(d.contents?.manifest.name).toBe("tool");
    expect((await w.index.list()).host).toMatchObject([
      {
        key: "tool@zed",
        marketplace: "zed",
        version: "2.0.0",
        addRefusedReason: expect.any(String),
      },
    ]);
    await expect(w.index.detail("nope@zed", { from: "host" })).rejects.toMatchObject({
      status: 404,
    });
  });
});
