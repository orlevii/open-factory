import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { LibrarySweep } from "./library-sweep.ts";
import { libraryLock } from "./locks.ts";
import { MarketplacesService, type MarketplacesStore } from "./marketplaces-service.ts";
import { SourcesService } from "./sources-service.ts";
import { type FixtureEntry, makeFixtureRepo } from "./testing/fixture-repo.ts";
import { memoryMarketplacesStore } from "./testing/memory-marketplaces-store.ts";
import { memorySourcesStore } from "./testing/memory-sources-store.ts";

// Counts the Library lock holders that are inside the lock right now (the lock's own boundary).
const depth = { n: 0 };
const realRun = libraryLock.run.bind(libraryLock);
vi.spyOn(libraryLock, "run").mockImplementation(((key: string, fn: () => Promise<unknown>) =>
  realRun(key, async () => {
    depth.n++;
    try {
      return await fn();
    } finally {
      depth.n--;
    }
  })) as typeof libraryLock.run);

let tmp: string;
let fh: string;
let nowMs: number;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-mkt-")));
  fh = path.join(tmp, "fh");
  mkdirSync(fh, { recursive: true });
  nowMs = Date.UTC(2026, 0, 1);
});
afterEach(async () => {
  const fix = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        chmodSync(p, 0o755);
        fix(p);
      }
    }
  };
  fix(tmp);
  await rm(tmp, { recursive: true, force: true });
});

type Users = Record<string, { templates: string[]; agents: string[] }>;
interface Setup {
  svc: MarketplacesService;
  store: MarketplacesStore;
  users: Users;
  declared: Array<{ marketplace: string; ref: string | null }>;
  /** Directories the loaded runtimes reference. */
  inUse: string[];
  frames: Array<{ addFailed?: string } | undefined>;
  publishDepth: number[];
  logged: string[];
}
function setup(
  o: { gitBin?: string; fileWalkCap?: number; store?: MarketplacesStore } = {},
): Setup {
  const store = o.store ?? memoryMarketplacesStore();
  const inUse: string[] = [];
  const users: Users = {};
  const declared: Setup["declared"] = [];
  const frames: Setup["frames"] = [];
  const publishDepth: number[] = [];
  const logged: string[] = [];
  const home = path.join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const svc = new MarketplacesService({
    store,
    usedBy: async (n) => users[n] ?? { templates: [], agents: [] },
    declaredRefs: async () => declared,
    inUse: () => inUse,
    factoryHome: fh,
    home,
    forbidden: { home, factoryHome: fh, dockerSockets: [] },
    githubUrl: `file://${tmp}/gh`,
    now: () => new Date(nowMs),
    gitBin: o.gitBin,
    fileWalkCap: o.fileWalkCap,
    log: (m) => logged.push(m),
    publish: (e) => {
      publishDepth.push(depth.n);
      frames.push(e);
    },
  });
  return { svc, store, users, declared, inUse, frames, publishDepth, logged };
}

const repoDir = () => path.join(tmp, "gh", "acme", "mk.git");
const EXT_SHA = "e".repeat(40);

const catalog = (plugins: unknown[], name = "acme"): Record<string, FixtureEntry> => ({
  ".claude-plugin/marketplace.json": JSON.stringify({ name, plugins }),
});

const github = { kind: "github", repo: "acme/mk" } as const;

function git(dir: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();
}

/** Adds one more commit to the fixture repo, replacing the given files. */
function commitMore(dir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "more"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function expectApi(p: Promise<unknown>, status: number, code: string) {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
  return e as ApiError;
}

const basicCatalog = catalog([
  { name: "rel", source: "./plugins/rel", version: "1.0.0", description: "A relative plugin" },
  { name: "ext", source: { source: "git-subdir", url: "acme/ext", path: "sub", sha: EXT_SHA } },
  { name: "floating", source: { source: "url", url: "https://example.com/f.git" } },
  { name: "npmy", source: { source: "npm", package: "x" } },
]);

async function basicRepo() {
  return makeFixtureRepo(repoDir(), {
    commits: [{ ...basicCatalog, "plugins/rel/README.md": "rel" }],
  });
}

describe("preview", () => {
  test("reads the catalog at the resolved commit, with what a pin can hold", async () => {
    const { shas } = await basicRepo();
    const p = await setup().svc.preview(github);
    expect(p).toMatchObject({
      name: "acme",
      source: { source: "github", repo: "acme/mk" },
      commit: shas[0],
      branch: "main",
      subject: "commit 1",
      commitPinnable: true,
    });
    expect(p.committedAt).toBe("2026-01-01T00:00:00.000Z".replace(".000Z", "Z"));
    expect(p.plugins).toEqual([
      {
        name: "rel",
        description: "A relative plugin",
        version: "1.0.0",
        pinnable: true,
        state: "ok",
      },
      { name: "ext", pinnable: true, state: "ok" },
      {
        name: "floating",
        pinnable: false,
        state: "cant_pin",
        refusedReason: "Can't be pinned: it follows its own source.",
      },
      {
        name: "npmy",
        pinnable: false,
        state: "refused",
        refusedReason: "Plugin npmy@acme uses a npm source, which Open Factory doesn't install.",
      },
    ]);
  });

  test("the official name is refused with a source that isn't Anthropic's", async () => {
    await makeFixtureRepo(repoDir(), { commits: [catalog([], "claude-plugins-official")] });
    await expectApi(setup().svc.preview(github), 400, "reserved_name");
  });

  test("the official name is allowed from Anthropic's repo, with commit pins marked refused", async () => {
    await makeFixtureRepo(path.join(tmp, "gh", "anthropics", "claude-plugins-official.git"), {
      commits: [catalog([], "claude-plugins-official")],
    });
    const p = await setup().svc.preview({
      kind: "github",
      repo: "anthropics/claude-plugins-official",
    });
    expect(p).toMatchObject({ name: "claude-plugins-official", commitPinnable: false });
  });

  test.each([
    ["a reserved name", "inline"],
    ["a name with a space", "a b"],
    ["a name that starts with a dot", ".x"],
  ])("refuses %s", async (_, name) => {
    await makeFixtureRepo(repoDir(), { commits: [catalog([], name)] });
    await expectApi(setup().svc.preview(github), 400, "bad_name");
  });

  test("refuses a name a ready or adding row, or a soft-deleted row inside its window, holds", async () => {
    await basicRepo();
    const s = setup();
    const { previewId } = await s.svc.preview(github);
    await s.svc.add(previewId, "@or");
    await expectApi(s.svc.preview(github), 409, "name_taken");
    await s.store.update("acme", { state: "adding" });
    await expectApi(s.svc.preview(github), 409, "name_taken");
    await s.store.update("acme", { state: "ready" });
    await s.svc.remove("acme");
    await expectApi(s.svc.preview(github), 409, "name_taken");
    nowMs += 31_000;
    expect((await s.svc.preview(github)).name).toBe("acme");
  });

  test("a repo without a catalog, an oversized catalog and invalid JSON are refused", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "README.md": "x" }] });
    await expectApi(setup().svc.preview(github), 400, "no_catalog");
    await rm(repoDir(), { recursive: true, force: true });
    await makeFixtureRepo(repoDir(), {
      commits: [{ ".claude-plugin/marketplace.json": { bytes: 1024 * 1024 + 1 } }],
    });
    await expectApi(setup().svc.preview(github), 400, "catalog_too_large");
    await rm(repoDir(), { recursive: true, force: true });
    await makeFixtureRepo(repoDir(), { commits: [{ ".claude-plugin/marketplace.json": "{nope" }] });
    await expectApi(setup().svc.preview(github), 400, "bad_catalog");
  });

  test("a folder's catalog that is a link is not followed", async () => {
    const dir = path.join(tmp, "local-mkt");
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(tmp, "real.json"), JSON.stringify({ name: "local", plugins: [] }));
    symlinkSync(path.join(tmp, "real.json"), path.join(dir, ".claude-plugin", "marketplace.json"));
    await expectApi(setup().svc.preview({ kind: "directory", path: dir }), 400, "no_catalog");
  });

  test("a repo over 50 MB is refused", async () => {
    await makeFixtureRepo(repoDir(), {
      commits: [{ ...catalog([]), big: { bytes: 51 * 1024 * 1024 } }],
    });
    await expectApi(setup().svc.preview(github), 400, "too_large");
  });

  test("a git url must be https without userinfo, a query or a fragment", async () => {
    for (const url of [
      "https://u:p@example.com/x.git",
      "https://example.com/x.git?a=1",
      "https://example.com/x.git#main",
      "http://example.com/x.git",
      "--upload-pack=x",
    ]) {
      const e = await setup()
        .svc.preview({ kind: "git", url })
        .catch((x) => x);
      expect(e).toMatchObject({ extra: { fields: { url: expect.any(String) } } });
    }
  });

  test("a folder is read in place, live, with no commit", async () => {
    const dir = path.join(tmp, "local-mkt");
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "local", plugins: [{ name: "p", source: "./p" }] }),
    );
    const p = await setup().svc.preview({ kind: "directory", path: dir });
    expect(p).toMatchObject({
      name: "local",
      source: { source: "directory", path: dir },
      commit: null,
      branch: null,
      plugins: [{ name: "p", pinnable: true }],
    });
  });

  test("a folder preview of the home folder is refused", async () => {
    const e = await setup()
      .svc.preview({ kind: "directory", path: "~" })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
  });
});

describe("add", () => {
  test("a live preview leaves a read-only checkout at <name>/<sha>/ and a ready row", async () => {
    const { shas } = await basicRepo();
    const s = setup();
    const p = await s.svc.preview(github);
    const out = await s.svc.add(p.previewId, "@or");
    expect(out.status).toBe(201);
    expect(out.marketplace).toMatchObject({
      name: "acme",
      state: "ready",
      commit: shas[0],
      usedBy: { templates: 0, agents: 0 },
    });
    const dir = path.join(fh, "state", "library", "marketplaces", "acme", shas[0] as string);
    expect(await s.svc.checkout("acme")).toBe(dir);
    expect(statSync(dir).mode & 0o222).toBe(0);
    expect(statSync(path.join(dir, "plugins", "rel", "README.md")).mode & 0o222).toBe(0);
    expect(existsSync(path.join(dir, ".git"))).toBe(false);
    // The preview's staging is gone and the frame went out after the Library lock was released.
    expect(readdirSync(path.join(fh, "state", "library", "preview"))).toEqual([]);
    expect(s.publishDepth.at(-1)).toBe(0);
  });

  test("an expired preview re-fetches the pin and answers 202, then the row is ready", async () => {
    const { shas } = await basicRepo();
    const s = setup();
    const p = await s.svc.preview(github);
    await rm(path.join(fh, "state", "library", "preview", p.previewId), {
      recursive: true,
      force: true,
    });
    const out = await s.svc.add(p.previewId, "@or");
    expect(out.status).toBe(202);
    expect(out.marketplace.state).toBe("adding");
    expect(await s.svc.checkout("acme")).toBeNull();
    await s.svc.idle();
    expect((await s.svc.detailOf("acme")).state).toBe("ready");
    expect(await s.svc.checkout("acme")).toContain(shas[0] as string);
  });

  test("a re-fetch that fails removes the row and sends addFailed", async () => {
    await basicRepo();
    const s = setup();
    const p = await s.svc.preview(github);
    await rm(path.join(fh, "state", "library", "preview", p.previewId), {
      recursive: true,
      force: true,
    });
    await rm(repoDir(), { recursive: true, force: true });
    await s.svc.add(p.previewId, "@or");
    await s.svc.idle();
    expect(await s.store.all()).toEqual([]);
    expect(s.frames.at(-1)).toEqual({ addFailed: "acme" });
    expect(s.logged.some((m) => m.includes("adding marketplace acme failed"))).toBe(true);
  });

  test("an unknown preview id is expired", async () => {
    const e = await setup()
      .svc.add("nope", "@or")
      .catch((x) => x);
    expect(e).toMatchObject({ extra: { fields: { previewId: expect.any(String) } } });
  });

  test("a folder adds as a live row with no checkout", async () => {
    const dir = path.join(tmp, "local-mkt");
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "local", plugins: [] }),
    );
    const s = setup();
    const p = await s.svc.preview({ kind: "directory", path: dir });
    const out = await s.svc.add(p.previewId, "@or");
    expect(out).toMatchObject({ status: 201, marketplace: { commit: null, tags: {} } });
    expect(await s.svc.checkout("local")).toBe(dir);
    await expectApi(s.svc.fetchAt("local", "a".repeat(40)), 409, "not_git");
  });

  test("adding over a row past its window keeps checkouts a loaded runtime references", async () => {
    const { shas } = await basicRepo();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await s.svc.remove("acme");
    nowMs += 31_000;
    const newSha = commitMore(repoDir(), { "more.txt": "x" });
    const root = path.join(fh, "state", "library", "marketplaces", "acme");
    const held = path.join(root, shas[0] as string);
    s.inUse.push(held);
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    expect(readdirSync(root).sort()).toEqual([shas[0], newSha].sort());
    // Once the runtime lets go, the next purge removes it.
    s.inUse.length = 0;
    await sweepFor(s).purge();
    expect(readdirSync(root)).toEqual([newSha]);
  });

  test("adding over a row past its window with nothing in use clears the old checkouts", async () => {
    const { shas } = await basicRepo();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await s.svc.remove("acme");
    nowMs += 31_000;
    const newSha = commitMore(repoDir(), { "more.txt": "x" });
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    expect(readdirSync(path.join(fh, "state", "library", "marketplaces", "acme"))).toEqual([
      newSha,
    ]);
    expect(shas[0]).not.toBe(newSha);
  });

  test("a name taken between preview and add is refused", async () => {
    await basicRepo();
    const s = setup();
    const a = await s.svc.preview(github);
    const b = await s.svc.preview(github);
    await s.svc.add(a.previewId, "@or");
    await expectApi(s.svc.add(b.previewId, "@or"), 409, "name_taken");
  });
});

describe("boot", () => {
  test("removes a row left adding and its checkouts", async () => {
    await basicRepo();
    const s = setup();
    const p = await s.svc.preview(github);
    await s.svc.add(p.previewId, "@or");
    await s.store.update("acme", { state: "adding" });
    const sweep = sweepFor(s);
    await sweep.purge({ boot: true });
    expect(await s.store.all()).toEqual([]);
    expect(existsSync(path.join(fh, "state", "library", "marketplaces", "acme"))).toBe(false);
  });
});

function sweepFor(s: Setup, inUse: string[] = []) {
  const sources = new SourcesService({
    store: memorySourcesStore(),
    usedBy: async () => ({ templates: [], agents: [] }),
    factoryHome: fh,
    hostClaudeDir: path.join(tmp, "claude"),
    forbidden: { home: tmp, factoryHome: fh, dockerSockets: [] },
    githubUrl: `file://${tmp}/gh`,
    now: () => new Date(nowMs),
    log: () => {},
  });
  return new LibrarySweep({
    sources,
    store: memorySourcesStore(),
    marketplaces: s.svc,
    factoryHome: fh,
    inUse: () => inUse,
    now: () => new Date(nowMs),
  });
}

describe("check all", () => {
  test("a background run that fails to start clears its marks, so the next check-all still checks", async () => {
    await basicRepo();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    const bg = vi
      .spyOn(s.svc as unknown as { background: () => void }, "background")
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    await expect(s.svc.startCheckAll()).rejects.toThrow("boom");
    bg.mockRestore();
    expect((await s.store.all())[0]?.checkedAt).toBeNull();
    await s.svc.startCheckAll();
    await s.svc.idle();
    expect((await s.store.all())[0]?.checkedAt).toBeInstanceOf(Date);
  });
});

describe("check and update", () => {
  const second = {
    ...catalog([
      { name: "docs", source: "./plugins/docs", version: "1.1.0" },
      { name: "hooky", source: "./plugins/hooky" },
      { name: "same", source: "./plugins/same" },
      {
        name: "ext",
        source: { source: "git-subdir", url: "acme/ext", path: "sub", sha: "f".repeat(40) },
      },
      { name: "fresh", source: "./plugins/fresh" },
    ]),
  };
  const firstCatalog = catalog([
    { name: "docs", source: "./plugins/docs", version: "1.0.0" },
    { name: "hooky", source: "./plugins/hooky" },
    { name: "same", source: "./plugins/same" },
    { name: "ext", source: { source: "git-subdir", url: "acme/ext", path: "sub", sha: EXT_SHA } },
    { name: "gone", source: "./plugins/gone" },
  ]);
  const baseFiles = {
    ...firstCatalog,
    "plugins/docs/README.md": "one",
    "plugins/hooky/hooks/hooks.json": '{"hooks":{}}',
    "plugins/same/README.md": "same",
    "plugins/gone/README.md": "gone",
  };

  async function added(): Promise<{ s: Setup; sha0: string }> {
    const { shas } = await makeFixtureRepo(repoDir(), { commits: [baseFiles] });
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    return { s, sha0: shas[0] as string };
  }

  test("check stores the newer commit and moves nothing else", async () => {
    const { s, sha0 } = await added();
    const sha1 = commitMore(repoDir(), { "plugins/docs/README.md": "two" });
    const d = await s.svc.check("acme");
    expect(d).toMatchObject({
      commit: sha0,
      updateCommit: sha1,
      updateSubject: "more",
      checkError: null,
    });
    expect(d.checkedAt).not.toBeNull();
    expect(s.publishDepth.at(-1)).toBe(0);
    expect(await s.svc.checkout("acme", sha1)).toBeNull();
  });

  test("check with nothing new clears a stale update", async () => {
    const { s } = await added();
    commitMore(repoDir(), { "plugins/docs/README.md": "two" });
    await s.svc.check("acme");
    git(repoDir(), ["reset", "-q", "--hard", "HEAD~1"]);
    const d = await s.svc.check("acme");
    expect(d.updateCommit).toBeNull();
    expect(d.checkError).toBeNull();
  });

  test("the update view lists changed plugins, running-code changes first", async () => {
    const { s, sha0 } = await added();
    const sha1 = commitMore(repoDir(), {
      ...Object.fromEntries(
        Object.entries(second).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
      ),
      "plugins/docs/README.md": "two",
      "plugins/hooky/hooks/hooks.json": '{"hooks":{"PreToolUse":[]}}',
      "plugins/fresh/README.md": "fresh",
    });
    await rm(path.join(repoDir(), "plugins", "gone"), { recursive: true });
    git(repoDir(), ["add", "-A"]);
    git(repoDir(), ["commit", "-q", "-m", "drop gone"]);
    const sha2 = git(repoDir(), ["rev-parse", "HEAD"]);
    await s.svc.check("acme");
    const view = await s.svc.updateView("acme");
    expect(view).toMatchObject({ from: sha0, to: sha2, subject: "drop gone" });
    expect(sha1).not.toBe(sha2);
    expect(view.changed).toEqual([
      { name: "ext", what: ["source"], runsCodeChanged: true },
      { name: "hooky", what: ["tree"], runsCodeChanged: true },
      { name: "docs", what: ["version", "tree"], runsCodeChanged: false },
    ]);
    expect(view.added).toEqual(["fresh"]);
    expect(view.removed).toEqual(["gone"]);
  });

  test("a plugin with more files than the walk reads is flagged, since the rest is unread", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`plugins/docs/f${i}.txt`] = `v${i}`;
    const { shas } = await makeFixtureRepo(repoDir(), { commits: [{ ...baseFiles, ...files }] });
    const s = setup({ fileWalkCap: 3 });
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    commitMore(repoDir(), { "plugins/docs/f0.txt": "changed" });
    await s.svc.check("acme");
    const view = await s.svc.updateView("acme");
    expect(view.from).toBe(shas[0]);
    expect(view.changed).toEqual([{ name: "docs", what: ["tree"], runsCodeChanged: true }]);
  });

  test("update moves the Library's commit, keeps the old checkout and touches no declaration", async () => {
    const { s, sha0 } = await added();
    s.users.acme = { templates: ["dev"], agents: ["ana"] };
    s.declared.push({ marketplace: "acme", ref: sha0 });
    const sha1 = commitMore(repoDir(), { "plugins/docs/README.md": "two" });
    await s.svc.check("acme");
    const d = await s.svc.update("acme", sha1, "@or");
    expect(d).toMatchObject({ commit: sha1, updateCommit: null, subject: "more" });
    expect(await s.svc.checkout("acme")).toContain(sha1);
    // A template pinned to the older commit still reads it.
    expect(await s.svc.checkout("acme", sha0)).toContain(sha0);
    expect(s.declared).toEqual([{ marketplace: "acme", ref: sha0 }]);
    expect(readdirSync(path.join(fh, "state", "library", "preview"))).toEqual([]);
  });

  test("update runs no ls-remote of its own: it keeps the tags the check recorded", async () => {
    const { s } = await added();
    const sha1 = commitMore(repoDir(), { "plugins/docs/README.md": "two" });
    git(repoDir(), ["tag", "-a", "v9", "-m", "r"]);
    await s.svc.check("acme");
    // The remote can't answer any more, so an update that asked it would lose or fail on the tag.
    git(repoDir(), ["tag", "-d", "v9"]);
    const d = await s.svc.update("acme", sha1, "@or");
    expect(d.tags).toEqual({ v9: sha1 });
  });

  test("an update names the commit the check found, nothing else", async () => {
    const { s } = await added();
    commitMore(repoDir(), { "plugins/docs/README.md": "two" });
    await s.svc.check("acme");
    await expectApi(s.svc.update("acme", "c".repeat(40), "@or"), 409, "stale_update");
    await expectApi(s.svc.updateView("nope"), 404, "not_found");
  });

  test("a failing check stores a redacted, capped error", async () => {
    await basicRepo();
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *ls-remote*--symref*) exec ${realGit} "$@";; esac\necho "fatal: unable to access 'https://user:tok123@example.com/x.git/' token=hunter2 ghp_abcdef123456" >&2\nexit 128\n`,
      { mode: 0o755 },
    );
    // The gitBin only fails after the marketplace is added: add with the real git first.
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    const failing = setup({ gitBin: path.join(bin, "git") });
    await failing.store.insert((await s.store.all())[0] as never);
    const d = await failing.svc.check("acme");
    expect(d.checkError).toContain("[redacted]");
    for (const secret of ["tok123", "hunter2", "ghp_abcdef123456"]) {
      expect(d.checkError).not.toContain(secret);
    }
  });
});

describe("tags and fetch", () => {
  async function twoCommits() {
    const { shas } = await makeFixtureRepo(repoDir(), {
      commits: [
        { ...catalog([]), "a.txt": "one" },
        { ...catalog([]), "a.txt": "two" },
      ],
      branches: { dev: 0 },
    });
    return shas as [string, string];
  }

  test("preview records an annotated and a lightweight tag at the commit, through ^{}", async () => {
    const [, head] = await twoCommits();
    git(repoDir(), ["tag", "-a", "v2", "-m", "release"]);
    git(repoDir(), ["tag", "light"]);
    git(repoDir(), ["tag", "-a", "v1", "-m", "old", "HEAD~1"]);
    const s = setup();
    const out = await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    // `v2` is a tag object whose own sha isn't the commit.
    expect(git(repoDir(), ["rev-parse", "v2"])).not.toBe(head);
    expect(out.marketplace.tags).toEqual({ v2: head, light: head });
  });

  test("check records a tag the update commit gained", async () => {
    await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    const sha = commitMore(repoDir(), { "a.txt": "three" });
    git(repoDir(), ["tag", "-a", "v3", "-m", "r"]);
    const d = await s.svc.check("acme");
    expect(d.updateCommit).toBe(sha);
    // Recorded for the commit the Library will move to, not the one it is at.
    expect(d.tags).toEqual({ v3: sha });
  });

  test("fetchAt creates a checkout at a commit", async () => {
    const [first] = await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    expect(await s.svc.checkout("acme", first)).toBeNull();
    expect(await s.svc.fetchAt("acme", first)).toEqual({ sha: first });
    const dir = await s.svc.checkout("acme", first);
    expect(dir).toContain(first);
    expect(statSync(dir as string).mode & 0o222).toBe(0);
    expect(execFileSync("cat", [path.join(dir as string, "a.txt")], { encoding: "utf8" })).toBe(
      "one",
    );
  });

  test("fetchAt creates a checkout at a tag and records it", async () => {
    const [first] = await twoCommits();
    git(repoDir(), ["tag", "-a", "old", "-m", "x", "HEAD~1"]);
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    expect(await s.svc.fetchAt("acme", "old")).toEqual({ sha: first });
    expect((await s.svc.detailOf("acme")).tags).toEqual({ old: first });
    // The tag now resolves to its checkout.
    expect(await s.svc.checkout("acme", "old")).toContain(first);
  });

  test("fetchAt refuses a branch, and says so", async () => {
    await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    const e = await expectApi(s.svc.fetchAt("acme", "dev"), 400, "pin_branch");
    expect(e.message).toBe("Pin acme to a commit or a tag.");
    expect((await s.svc.detailOf("acme")).tags).toEqual({});
  });

  test("a tag that has the same name as a branch is a tag", async () => {
    const [first] = await twoCommits();
    git(repoDir(), ["tag", "dev", first]);
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    expect(await s.svc.fetchAt("acme", "dev")).toEqual({ sha: first });
  });

  test.each([
    ["an unknown name", "nope", 404, "no_ref"],
    ["a commit the repo doesn't have", "d".repeat(40), 400, "validation_error"],
    ["an option", "--upload-pack=x", 400, "validation_error"],
  ])("fetchAt refuses %s", async (_, ref, status, code) => {
    await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await expectApi(s.svc.fetchAt("acme", ref), status, code);
  });

  test("fetchAt on a row still being added says so", async () => {
    const [first] = await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await s.store.update("acme", { state: "adding" });
    const e = await expectApi(s.svc.fetchAt("acme", first), 409, "adding");
    expect(e.message).toBe("This marketplace is still being added.");
  });

  test("fetchAt records the tag while the Library lock is held and its checkout exists", async () => {
    const [first] = await twoCommits();
    git(repoDir(), ["tag", "-a", "old", "-m", "x", "HEAD~1"]);
    const inner = memoryMarketplacesStore();
    const seen: Array<{ lockHeld: boolean; checkout: boolean }> = [];
    const store: MarketplacesStore = {
      ...inner,
      update: async (name, patch) => {
        if (patch.tags?.old) {
          seen.push({
            lockHeld: depth.n > 0,
            checkout: existsSync(path.join(fh, "state", "library", "marketplaces", name, first)),
          });
        }
        return inner.update(name, patch);
      },
    };
    const s = setup({ store });
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await s.svc.fetchAt("acme", "old");
    expect(seen).toEqual([{ lockHeld: true, checkout: true }]);
  });

  test("checkout answers null for a path that isn't a commit or a recorded tag", async () => {
    await twoCommits();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    for (const ref of ["../x", "nope", "a".repeat(40)]) {
      expect(await s.svc.checkout("acme", ref)).toBeNull();
    }
    expect(await s.svc.checkout("../acme")).toBeNull();
    expect(await s.svc.checkout("missing")).toBeNull();
  });
});

describe("remove and restore", () => {
  async function ready() {
    await basicRepo();
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    return s;
  }

  test("is refused while a template declares the marketplace, naming up to three users", async () => {
    const s = await ready();
    s.users.acme = { templates: ["dev", "ops"], agents: ["ana", "bo", "cy"] };
    const e = await expectApi(s.svc.remove("acme"), 409, "in_use");
    expect(e.message).toBe(
      "Templates use plugins from acme (template dev, template ops, @ana and 2 more). Remove them first.",
    );
    expect((await s.store.all())[0]?.deletedAt).toBeNull();
  });

  test("an unused marketplace is soft deleted with a 30 s window and Undo restores it", async () => {
    const s = await ready();
    const out = await s.svc.remove("acme");
    expect(out.undoUntil).toBe(new Date(nowMs + 30_000).toISOString());
    expect(await s.svc.checkout("acme")).toBeNull();
    await expectApi(s.svc.detailOf("acme"), 404, "not_found");
    nowMs += 29_000;
    expect((await s.svc.restore("acme", "@or")).name).toBe("acme");
    expect(await s.svc.checkout("acme")).not.toBeNull();
  });

  test("Undo is over after 30 s", async () => {
    const s = await ready();
    await s.svc.remove("acme");
    nowMs += 30_000;
    await expectApi(s.svc.restore("acme", "@or"), 409, "undo_over");
  });
});

describe("purge", () => {
  async function threeCheckouts() {
    const { shas } = await makeFixtureRepo(repoDir(), {
      commits: [
        { ...catalog([]), "a.txt": "one" },
        { ...catalog([]), "a.txt": "two" },
        { ...catalog([]), "a.txt": "three" },
      ],
    });
    git(repoDir(), ["tag", "-a", "pinned", "-m", "x", "HEAD~2"]);
    const s = setup();
    await s.svc.add((await s.svc.preview(github)).previewId, "@or");
    await s.svc.fetchAt("acme", shas[1] as string);
    await s.svc.fetchAt("acme", "pinned");
    return { s, shas: shas as [string, string, string] };
  }
  const dirs = () => readdirSync(path.join(fh, "state", "library", "marketplaces", "acme")).sort();

  test("keeps a checkout a declaration references, by commit or by tag, and removes one nothing references", async () => {
    const { s, shas } = await threeCheckouts();
    expect(dirs()).toEqual([...shas].sort());
    s.declared.push({ marketplace: "acme", ref: shas[1] }, { marketplace: "acme", ref: "pinned" });
    await sweepFor(s).purge();
    expect(dirs()).toEqual([...shas].sort());
    s.declared.length = 0;
    await sweepFor(s).purge();
    // Only the Library's commit is left.
    expect(dirs()).toEqual([shas[2]]);
  });

  test("keeps a checkout a loaded runtime's started.library references, until it is released", async () => {
    const { s, shas } = await threeCheckouts();
    const held = path.join(fh, "state", "library", "marketplaces", "acme", shas[0]);
    await sweepFor(s, [held]).purge();
    expect(dirs()).toEqual([shas[0], shas[2]].sort());
    await sweepFor(s, []).purge();
    expect(dirs()).toEqual([shas[2]]);
  });

  test("a soft-deleted marketplace goes with its checkouts once its window is over, and not before", async () => {
    const { s } = await threeCheckouts();
    await s.svc.remove("acme");
    await sweepFor(s).purge();
    expect(await s.store.all()).toHaveLength(1);
    nowMs += 31_000;
    await sweepFor(s).purge();
    expect(await s.store.all()).toEqual([]);
    expect(existsSync(path.join(fh, "state", "library", "marketplaces", "acme"))).toBe(false);
  });

  test("a soft-deleted marketplace a runtime still references keeps its directory and row", async () => {
    const { s, shas } = await threeCheckouts();
    await s.svc.remove("acme");
    nowMs += 31_000;
    const held = path.join(fh, "state", "library", "marketplaces", "acme", shas[2]);
    await sweepFor(s, [held]).purge();
    expect(await s.store.all()).toHaveLength(1);
    expect(existsSync(held)).toBe(true);
  });

  test("a checkout of a marketplace with no row is removed", async () => {
    const s = setup();
    const orphan = path.join(fh, "state", "library", "marketplaces", "ghost", "a".repeat(40));
    mkdirSync(orphan, { recursive: true });
    await sweepFor(s).purge();
    expect(existsSync(path.join(fh, "state", "library", "marketplaces", "ghost"))).toBe(false);
  });

  test("an external plugin source checkout is removed after a day", async () => {
    const s = setup();
    const dir = path.join(fh, "state", "library", "plugin-sources", "h".repeat(32), "a".repeat(40));
    mkdirSync(dir, { recursive: true });
    utimesSync(dir, nowMs / 1000, nowMs / 1000);
    await sweepFor(s).purge();
    expect(existsSync(dir)).toBe(true);
    nowMs += 25 * 60 * 60 * 1000;
    await sweepFor(s).purge();
    expect(existsSync(dir)).toBe(false);
  });
});
