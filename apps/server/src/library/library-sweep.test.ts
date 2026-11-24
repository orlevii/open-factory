import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillSourceRow } from "@open-factory/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LibrarySweep, marketplaceDirsInUse, skillDirsInUse } from "./library-sweep.ts";
import { SourcesService, type SourcesStore } from "./sources-service.ts";
import { memorySourcesStore } from "./testing/memory-sources-store.ts";

let tmp: string;
let fh: string;
let nowMs: number;
let store: SourcesStore;
let inUse: string[];
let sweep: LibrarySweep;
let logged: string[];
let svc: SourcesService;
const T0 = Date.UTC(2026, 0, 1, 12);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-sweep-")));
  fh = path.join(tmp, "fh");
  mkdirSync(fh);
  nowMs = T0;
  inUse = [];
  logged = [];
  store = memorySourcesStore();
  svc = new SourcesService({
    store,
    usedByAny: async () => ({ templates: [], agents: [] }),
    factoryHome: fh,
    hostClaudeDir: path.join(tmp, "claude"),
    forbidden: { home: tmp, factoryHome: fh, dockerSockets: [] },
    githubUrl: `file://${tmp}/gh`,
    now: () => new Date(nowMs),
    log: (m) => logged.push(m),
  });
  sweep = new LibrarySweep({
    sources: svc,
    store,
    factoryHome: fh,
    inUse: () => inUse,
    now: () => new Date(nowMs),
    log: (m) => logged.push(m),
  });
});
afterEach(async () => {
  await sweep.stop();
  const fix = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        chmodSync(path.join(d, e.name), 0o755);
        fix(path.join(d, e.name));
      }
    }
  };
  fix(tmp);
  await rm(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

const SHA = "a".repeat(40);
const NEW = "b".repeat(40);
const row = (id: string, o: Partial<SkillSourceRow> = {}): SkillSourceRow => ({
  id,
  kind: "github",
  path: null,
  repo: "acme/x",
  subpath: "",
  branch: "main",
  commit: SHA,
  committedAt: null,
  subject: null,
  trees: null,
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  skills: ["tdd"],
  state: "ready",
  startedAt: new Date(T0),
  addedBy: "@or",
  addedAt: new Date(T0),
  deletedAt: null,
  ...o,
});
const cache = (id: string, sha = SHA) => {
  const dir = path.join(fh, "state/library/github", id, sha);
  mkdirSync(path.join(dir, "tdd"), { recursive: true });
  writeFileSync(path.join(dir, "tdd/SKILL.md"), "x");
  return dir;
};
const preview = (name: string, ageMs: number) => {
  const dir = path.join(fh, "state/library/preview", name);
  mkdirSync(dir, { recursive: true });
  const t = new Date(nowMs - ageMs);
  utimesSync(dir, t, t);
  return dir;
};
const ids = async () => (await store.all()).map((r) => r.id);

test("previews older than an hour are removed and newer ones kept", async () => {
  const old = preview("old", 61 * 60_000);
  const fresh = preview("fresh", 59 * 60_000);
  await sweep.purge();
  expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
});

test("a source past its Undo window is purged with its cache, one inside it is kept", async () => {
  await store.insert(row("gone", { deletedAt: new Date(T0 - 31_000) }));
  await store.insert(row("undoable", { deletedAt: new Date(T0 - 29_000) }));
  const goneDir = cache("gone");
  const undoDir = cache("undoable");
  await sweep.purge();
  expect(await ids()).toEqual(["undoable"]);
  expect([existsSync(goneDir), existsSync(undoDir)]).toEqual([false, true]);
});

test("a purge skips a cache a loaded runtime references and retries once it doesn't", async () => {
  await store.insert(row("busy", { deletedAt: new Date(T0 - 60_000) }));
  const dir = cache("busy");
  inUse = [path.join(dir, "tdd")];
  await sweep.purge();
  expect(await ids()).toEqual(["busy"]);
  expect(existsSync(dir)).toBe(true);
  inUse = [];
  await sweep.purge();
  expect(await ids()).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test("boot purge removes every soft-deleted row, whatever its window, and every preview", async () => {
  await store.insert(row("recent", { deletedAt: new Date(T0 - 1000) }));
  await store.insert(row("live"));
  const liveDir = cache("live");
  const recentDir = cache("recent");
  const p = preview("p", 1000);
  await sweep.bootPurge();
  expect(await ids()).toEqual(["live"]);
  expect([existsSync(liveDir), existsSync(recentDir), existsSync(p)]).toEqual([true, false, false]);
});

test("boot purge keeps a row whose cache a loaded runtime references", async () => {
  await store.insert(row("busy", { deletedAt: new Date(T0 - 1000) }));
  inUse = [cache("busy")];
  await sweep.bootPurge();
  expect(await ids()).toEqual(["busy"]);
});

test("a pin an update replaced and the cache of a vanished row are removed, the live pin stays", async () => {
  await store.insert(row("a", { commit: NEW }));
  const live = cache("a", NEW);
  const stale = cache("a", SHA);
  const orphan = cache("nobody");
  const pinned = cache("a", "c".repeat(40));
  inUse = [path.join(pinned, "tdd")];
  await sweep.purge();
  expect([existsSync(live), existsSync(stale), existsSync(orphan), existsSync(pinned)]).toEqual([
    true,
    false,
    false,
    true,
  ]);
});

test("the one-shot purge fires after the Undo window", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  await store.insert(row("gone", { deletedAt: new Date(T0 - 31_000) }));
  sweep.purgeAfter(30_000);
  await vi.advanceTimersByTimeAsync(30_250);
  await sweep.stop();
  expect(await ids()).toEqual([]);
});

test("stop cancels timers that haven't fired", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  await store.insert(row("gone", { deletedAt: new Date(T0 - 31_000) }));
  sweep.start();
  sweep.purgeAfter(30_000);
  await sweep.stop();
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
  expect(await ids()).toEqual(["gone"]);
});

test("the hourly timer purges", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  await store.insert(row("gone", { deletedAt: new Date(T0 - 31_000) }));
  sweep.start();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await sweep.stop();
  expect(await ids()).toEqual([]);
});

test("a purge removes a read-only cache tree like an installed pin", async () => {
  await store.insert(row("ro", { deletedAt: new Date(T0 - 60_000) }));
  const dir = cache("ro");
  chmodSync(path.join(dir, "tdd/SKILL.md"), 0o444);
  chmodSync(path.join(dir, "tdd"), 0o555);
  chmodSync(dir, 0o555);
  await sweep.purge();
  expect(existsSync(dir)).toBe(false);
  expect(await ids()).toEqual([]);
});

test("one source that can't be purged doesn't stop the others, and the rest are announced", async () => {
  const published: number[] = [];
  await store.insert(row("bad", { deletedAt: new Date(T0 - 60_000) }));
  await store.insert(row("good", { deletedAt: new Date(T0 - 60_000), addedAt: new Date(T0 + 1) }));
  const failing: SourcesStore = {
    ...store,
    delete: async (id) => {
      if (id === "bad") throw new Error("disk says no");
      await store.delete(id);
    },
  };
  const s = new LibrarySweep({
    sources: svc,
    store: failing,
    factoryHome: fh,
    inUse: () => [],
    now: () => new Date(nowMs),
    publish: () => published.push(1),
    log: (m) => logged.push(m),
  });
  await s.purge();
  expect(await ids()).toEqual(["bad"]);
  expect(logged).toEqual(["purging source bad failed"]);
  expect(published).toEqual([1]);
});

test("boot purge starts the repair of interrupted adds without waiting for it", async () => {
  await store.insert(row("stuck", { state: "adding" }));
  await sweep.bootPurge();
  await svc.idle();
  // Its repo can't be fetched, so the repair removed it.
  expect(await ids()).toEqual([]);
});

test("skillDirsInUse holds every source's directory for the hashes the running processes started with", async () => {
  const root = path.join(fh, "state", "library", "github");
  mkdirSync(path.join(root, "src1"), { recursive: true });
  mkdirSync(path.join(root, "src2"), { recursive: true });
  const started: { library: { skills: Record<string, string> } }[] = [
    { library: { skills: { tdd: `github:${"a".repeat(40)}`, mine: "host", dir: "folder" } } },
    { library: { skills: { x: "missing" } } },
  ];
  expect((await skillDirsInUse(root, started)).sort()).toEqual([
    path.join(root, "src1", "a".repeat(40)),
    path.join(root, "src2", "a".repeat(40)),
  ]);
  expect(await skillDirsInUse(root, [{ library: { skills: { x: "host" } } }])).toEqual([]);
  expect(await skillDirsInUse(path.join(fh, "nothing-here"), started)).toEqual([]);
});

test("a runtime's commit and tag pins hold their marketplace checkouts; Latest and live hold none", () => {
  const sha = "b".repeat(40);
  const tagSha = "c".repeat(40);
  const started = [
    {
      library: {
        plugins: {
          "foo@acme": `commit:${sha}`,
          "bar@acme": "tag:v1",
          "baz@beta": "latest",
          "qux@mine": "live",
          "old@acme": "tag:gone",
        },
      },
    },
  ];
  const rows: { name: string; tags: Record<string, string> }[] = [
    { name: "acme", tags: { v1: tagSha } },
    { name: "beta", tags: {} },
  ];
  expect(marketplaceDirsInUse("/mk", started, rows).sort()).toEqual(
    [`/mk/acme/${sha}`, `/mk/acme/${tagSha}`].sort(),
  );
});

test("a tag pin named like an Object.prototype member holds nothing", () => {
  const started = [
    { library: { plugins: { "foo@acme": "tag:constructor", "bar@acme": "tag:toString" } } },
  ];
  expect(marketplaceDirsInUse("/mk", started, [{ name: "acme", tags: {} }])).toEqual([]);
});
