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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { HOST_MSG, HostPlugins, hostSourceVerdict } from "./host-plugins.ts";
import { MarketplacesService } from "./marketplaces-service.ts";
import { makeFixtureRepo } from "./testing/fixture-repo.ts";
import { memoryMarketplacesStore } from "./testing/memory-marketplaces-store.ts";

const reads: string[] = [];
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: ((f: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
      reads.push(String(f));
      return (real.readFile as (...a: unknown[]) => unknown)(f, ...rest);
    }) as typeof real.readFile,
  };
});

/** I5 §7.6: the host's installed plugins and Add its marketplace, on a temp host dir in the v2 shape. */
let tmp: string;
let host: string;
let fh: string;
let registered: string[];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-hostplug-")));
  host = path.join(tmp, "claude");
  fh = path.join(tmp, "fh");
  mkdirSync(path.join(host, "plugins", "cache"), { recursive: true });
  mkdirSync(fh, { recursive: true });
  registered = [];
});
afterEach(async () => {
  // Marketplace checkouts are read-only.
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

const cacheDir = (mkt: string, plugin: string, version: string) =>
  path.join(host, "plugins", "cache", mkt, plugin, version);

/** A plugin folder with a manifest and one hook, so its contents have something to show. */
function pluginAt(dir: string, name: string, version: string) {
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  mkdirSync(path.join(dir, "hooks"), { recursive: true });
  writeFileSync(
    path.join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node run.js" }] }] } }),
  );
}

const install = (installPath: string, version: string, lastUpdated: string) => ({
  scope: "user",
  installPath,
  version,
  lastUpdated,
});

function writeHost(
  plugins: Record<string, unknown[]>,
  known: Record<string, unknown> = {
    acme: { source: { source: "github", repo: "acme/mk" }, autoUpdate: false },
  },
) {
  writeFileSync(
    path.join(host, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
  );
  writeFileSync(path.join(host, "plugins", "known_marketplaces.json"), JSON.stringify(known));
}

function make(svc?: MarketplacesService) {
  return new HostPlugins({
    hostClaudeDir: host,
    forbidden: { home: path.join(tmp, "home"), factoryHome: fh, dockerSockets: [] },
    registered: async () => registered,
    marketplaces: svc ?? {
      preview: async () => {
        throw new Error("no preview in this test");
      },
      add: async () => {
        throw new Error("no add in this test");
      },
    },
  });
}

describe("list", () => {
  test("lists each key once, from its install with the newest lastUpdated, with its contents", async () => {
    const older = cacheDir("acme", "foo", "1.0.0");
    const newer = cacheDir("acme", "foo", "1.1.0");
    pluginAt(older, "foo", "1.0.0");
    pluginAt(newer, "foo", "1.1.0");
    writeHost({
      "foo@acme": [
        install(newer, "1.1.0", "2026-03-01T00:00:00Z"),
        install(older, "1.0.0", "2026-01-01T00:00:00Z"),
      ],
    });
    const [e, ...rest] = await make().list();
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      key: "foo@acme",
      name: "foo",
      marketplace: "acme",
      version: "1.1.0",
    });
    expect(e?.contents?.manifest.version).toBe("1.1.0");
    expect(e?.contents?.summary.hooks).toBe(1);
    expect(e?.cantShow).toBeUndefined();
  });

  test("a key whose marketplace is registered is left out, but its host version is still known", async () => {
    const dir = cacheDir("acme", "foo", "1.2.0");
    pluginAt(dir, "foo", "1.2.0");
    writeHost({ "foo@acme": [install(dir, "1.2.0", "2026-03-01T00:00:00Z")] });
    registered = ["acme"];
    const hp = make();
    expect(await hp.list()).toEqual([]);
    expect((await hp.versions()).get("foo@acme")).toBe("1.2.0");
  });

  test("an installPath outside the host's plugin cache can't be shown, even through a link", async () => {
    const outside = path.join(tmp, "elsewhere", "foo");
    pluginAt(outside, "foo", "9.9.9");
    const linked = cacheDir("acme", "bar", "1.0.0");
    mkdirSync(path.dirname(linked), { recursive: true });
    symlinkSync(outside, linked);
    writeHost({
      "foo@acme": [install(outside, "9.9.9", "2026-03-01T00:00:00Z")],
      "bar@acme": [install(linked, "1.0.0", "2026-03-01T00:00:00Z")],
    });
    const listed = await make().list();
    expect(listed.map((e) => [e.key, e.cantShow, e.contents])).toEqual([
      ["bar@acme", "Can't show: outside the host's plugin folder.", null],
      ["foo@acme", "Can't show: outside the host's plugin folder.", null],
    ]);
  });

  test("a host directory marketplace's folder is a place contents may be read from", async () => {
    const folder = path.join(tmp, "my-mkt");
    pluginAt(path.join(folder, "plugins", "foo"), "foo", "0.1.0");
    writeHost(
      {
        "foo@mine": [install(path.join(folder, "plugins", "foo"), "0.1.0", "2026-03-01T00:00:00Z")],
      },
      { mine: { source: { source: "directory", path: folder } } },
    );
    const [e] = await make().list();
    expect(e?.cantShow).toBeUndefined();
    expect(e?.contents?.manifest.name).toBe("foo");
  });

  test.each([
    ["the filesystem root", () => "/"],
    ["the home folder", () => path.join(tmp, "home")],
    ["an ancestor of the home folder", () => tmp],
    ["the factory's folder", () => fh],
    ["a relative path", () => "relative/dir"],
  ])(
    "a host directory marketplace at %s doesn't widen where contents are read",
    async (_, root) => {
      mkdirSync(path.join(tmp, "home"), { recursive: true });
      const outside = path.join(tmp, "elsewhere", "foo");
      pluginAt(outside, "foo", "9.9.9");
      writeHost(
        { "foo@mine": [install(outside, "9.9.9", "2026-03-01T00:00:00Z")] },
        { mine: { source: { source: "directory", path: root() } } },
      );
      const [e] = await make().list();
      expect(e?.cantShow).toBe("Can't show: outside the host's plugin folder.");
      expect(e?.contents).toBeNull();
    },
  );

  test("reads each host JSON file once per list, not once per key", async () => {
    const keys: Record<string, unknown[]> = {};
    for (const n of ["a", "b", "c"]) {
      const dir = cacheDir("acme", n, "1.0.0");
      pluginAt(dir, n, "1.0.0");
      keys[`${n}@acme`] = [install(dir, "1.0.0", "2026-03-01T00:00:00Z")];
    }
    writeHost(keys);
    reads.length = 0;
    try {
      expect(await make().list()).toHaveLength(3);
      const jsons = reads.filter(
        (f) => f.endsWith("_plugins.json") || f.endsWith("_marketplaces.json"),
      );
      expect(jsons).toHaveLength(2);
    } finally {
      reads.length = 0;
    }
  });

  test.each([
    ["userinfo", { source: "git", url: "https://user:pw@example.com/acme/mk.git" }],
    ["a ref", { source: "github", repo: "acme/mk", ref: "main" }],
    ["a path", { source: "git", url: "https://example.com/acme/mk.git", path: "sub" }],
    ["a query", { source: "git", url: "https://example.com/acme/mk.git?token=x" }],
    ["an http URL", { source: "git", url: "http://example.com/acme/mk.git" }],
    ["a settings source", { source: "settings", name: "acme" }],
  ])("a host record with %s can't be used to add the marketplace", async (_, source) => {
    const dir = cacheDir("acme", "foo", "1.0.0");
    pluginAt(dir, "foo", "1.0.0");
    writeHost(
      { "foo@acme": [install(dir, "1.0.0", "2026-03-01T00:00:00Z")] },
      { acme: { source } },
    );
    const [e] = await make().list();
    expect(e?.addRefusedReason).toMatch(/^The host's record for acme can't be used: .+\.$/);
    expect(e?.addRefusedReason).not.toContain("pw");
    expect(e?.addRefusedReason).not.toContain("token");
    await expect(make().addMarketplace("foo@acme", "@or")).rejects.toMatchObject({
      status: 400,
      code: "host_record_unusable",
      message: e?.addRefusedReason,
    });
  });

  test("a plain https git record and a github record are usable", () => {
    expect(hostSourceVerdict({ source: { source: "github", repo: "acme/mk" } })).toMatchObject({
      ok: true,
    });
    expect(
      hostSourceVerdict({ source: { source: "git", url: "https://example.com/a/b.git" } }),
    ).toMatchObject({ ok: true });
  });

  test("files over the size cap, links and bad JSON read as an empty host", async () => {
    writeFileSync(path.join(host, "plugins", "installed_plugins.json"), "{ not json");
    expect(await make().list()).toEqual([]);
    writeFileSync(
      path.join(host, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {}, pad: "x".repeat(300 * 1024) }),
    );
    expect(await make().list()).toEqual([]);
  });
});

describe("add its marketplace", () => {
  const catalog = (name: string) => ({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name,
      plugins: [{ name: "foo", source: "./plugins/foo" }],
    }),
    "plugins/foo/.claude-plugin/plugin.json": JSON.stringify({ name: "foo", version: "1.0.0" }),
  });
  const service = () => {
    const home = path.join(tmp, "home");
    mkdirSync(home, { recursive: true });
    const store = memoryMarketplacesStore();
    const svc = new MarketplacesService({
      store,
      usedBy: async () => ({ templates: [], agents: [] }),
      factoryHome: fh,
      home,
      forbidden: { home, factoryHome: fh, dockerSockets: [] },
      githubUrl: `file://${tmp}/gh`,
      log: () => {},
    });
    return { svc, store };
  };

  test("previews the host's recorded source and registers it, so the plugin is pickable", async () => {
    const { shas } = await makeFixtureRepo(path.join(tmp, "gh", "acme", "mk.git"), {
      commits: [catalog("acme")],
    });
    const dir = cacheDir("acme", "foo", "1.0.0");
    pluginAt(dir, "foo", "1.0.0");
    writeHost({ "foo@acme": [install(dir, "1.0.0", "2026-03-01T00:00:00Z")] });
    const { svc, store } = service();
    const r = await make(svc).addMarketplace("foo@acme", "@or");
    expect(r.status).toBe(201);
    expect(r.marketplace).toMatchObject({ name: "acme", commit: shas[0], state: "ready" });
    expect((await store.all()).map((x) => [x.name, x.source])).toEqual([
      ["acme", { source: "github", repo: "acme/mk" }],
    ]);
  });

  test("is refused when the name is registered with another source", async () => {
    await makeFixtureRepo(path.join(tmp, "gh", "acme", "mk.git"), { commits: [catalog("acme")] });
    await makeFixtureRepo(path.join(tmp, "gh", "acme", "other.git"), {
      commits: [catalog("acme")],
    });
    const dir = cacheDir("acme", "foo", "1.0.0");
    pluginAt(dir, "foo", "1.0.0");
    const { svc } = service();
    const first = await svc.preview({ kind: "github", repo: "acme/other" });
    await svc.add(first.previewId, "@or");
    writeHost({ "foo@acme": [install(dir, "1.0.0", "2026-03-01T00:00:00Z")] });
    const e = await make(svc)
      .addMarketplace("foo@acme", "@or")
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({
      status: 409,
      code: "name_taken",
    });
  });

  test("is refused when the repo's catalog has another name than the host's record", async () => {
    await makeFixtureRepo(path.join(tmp, "gh", "acme", "mk.git"), { commits: [catalog("other")] });
    const dir = cacheDir("acme", "foo", "1.0.0");
    pluginAt(dir, "foo", "1.0.0");
    writeHost({ "foo@acme": [install(dir, "1.0.0", "2026-03-01T00:00:00Z")] });
    const { svc, store } = service();
    await expect(make(svc).addMarketplace("foo@acme", "@or")).rejects.toMatchObject({
      status: 400,
      code: "host_record_unusable",
    });
    expect(await store.all()).toEqual([]);
  });

  test("a key the host doesn't have is a 404, and a marketplace with no host record is refused", async () => {
    const dir = cacheDir("acme", "foo", "1.0.0");
    pluginAt(dir, "foo", "1.0.0");
    writeHost({ "foo@acme": [install(dir, "1.0.0", "2026-03-01T00:00:00Z")] }, {});
    const hp = make();
    await expect(hp.addMarketplace("nope@acme", "@or")).rejects.toMatchObject({ status: 404 });
    await expect(hp.addMarketplace("foo@acme", "@or")).rejects.toMatchObject({
      message: HOST_MSG.recordUnusable("acme", HOST_MSG.noRecord),
    });
  });
});
