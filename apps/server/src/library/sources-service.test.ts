import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillSourceRow } from "@open-factory/db";
import { MSG } from "@open-factory/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { testRef } from "../test/principals.ts";
import { runGit } from "./git.ts";
import { removeTree } from "./git-fetch.ts";
import { libraryLock } from "./locks.ts";
import { SourcesService, type SourcesStore } from "./sources-service.ts";
import { makeFixtureRepo } from "./testing/fixture-repo.ts";
import { memorySourcesStore } from "./testing/memory-sources-store.ts";

const OR = { id: "u-or", ref: testRef("u-or"), handle: "or" };
const ANA = { id: "u-ana", ref: testRef("u-ana"), handle: "ana" };

const gate = vi.hoisted(() => ({ delayMs: 0, inflight: 0, max: 0 }));
vi.mock("./git.ts", async (orig) => {
  const m = await orig<typeof import("./git.ts")>();
  const real = m.runGit;
  return {
    ...m,
    runGit: vi.fn(async (...a: Parameters<typeof real>) => {
      gate.inflight++;
      gate.max = Math.max(gate.max, gate.inflight);
      try {
        if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
        return await real(...a);
      } finally {
        gate.inflight--;
      }
    }),
  };
});

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
let claude: string;
let home: string;
let nowMs: number;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-src-")));
  fh = path.join(tmp, "fh");
  claude = path.join(tmp, "claude");
  home = path.join(tmp, "home");
  for (const d of [fh, path.join(claude, "skills"), home]) mkdirSync(d, { recursive: true });
  nowMs = Date.UTC(2026, 0, 1);
  gate.delayMs = 0;
  gate.inflight = 0;
  gate.max = 0;
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

const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: about ${name}\n${extra}---\n# ${name}\n`;
const hookFm = (cmd: string) =>
  `hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ${cmd}\n`;

type Users = Record<string, { templates: string[]; agents: string[] }>;
interface Setup {
  svc: SourcesService;
  store: SourcesStore;
  users: Users;
  changed: Array<{
    skills?: string[];
    by: string;
    before?: { skills: Record<string, string> };
  }>;
  /** The row's pin at each `captureLibrary` call. */
  captured: (string | null | undefined)[];
  lockFreeInCallback: boolean[];
  /** How many Library lock holders were active at each `publish`. */
  publishDepth: number[];
  /** The argument of each `publish`. */
  frames: Array<{ addFailed?: string } | undefined>;
  logged: string[];
}
function setup(o: { users?: Users; fileWalkCap?: number } = {}): Setup {
  const store = memorySourcesStore();
  const users: Users = o.users ?? {};
  const changed: Setup["changed"] = [];
  const captured: Setup["captured"] = [];
  const lockFreeInCallback: boolean[] = [];
  const publishDepth: number[] = [];
  const frames: Setup["frames"] = [];
  const logged: string[] = [];
  const svc = new SourcesService({
    store,
    usedByAny: async (names) => ({
      templates: [...new Set(names.flatMap((n) => users[n]?.templates ?? []))].sort(),
      agents: [...new Set(names.flatMap((n) => users[n]?.agents ?? []))].sort(),
    }),
    factoryHome: fh,
    hostClaudeDir: claude,
    home,
    forbidden: { home, factoryHome: fh, dockerSockets: [] },
    githubUrl: `file://${tmp}/gh`,
    now: () => new Date(nowMs),
    fileWalkCap: o.fileWalkCap,
    log: (m) => logged.push(m),
    publish: (e) => {
      publishDepth.push(depth.n);
      frames.push(e);
    },
    captureLibrary: async (skills) => {
      // The pin the row has when the Library is captured: it must still be the old one.
      captured.push((await store.all())[0]?.commit);
      return { skills: Object.fromEntries(skills.map((n) => [n, "captured"])) };
    },
    onLibraryChanged: async (e) => {
      changed.push(e);
      // Would never settle if the Library lock were still held.
      lockFreeInCallback.push(await libraryLock.run("library", async () => true));
    },
  });
  return { svc, store, users, changed, captured, lockFreeInCallback, publishDepth, frames, logged };
}

const repoDir = () => path.join(tmp, "gh", "acme", "x.git");
const ghBody = (previewId: string, skills: string[]) =>
  ({ kind: "github", previewId, skills }) as const;
const preview = (s: Setup, extra: { subpath?: string; branch?: string } = {}) =>
  s.svc.preview({ kind: "github", repo: "acme/x", ...extra }, OR);

/** Commit 0 on branch `old`, commit 1 on main. */
async function twoCommitRepo(
  first: Record<string, import("./testing/fixture-repo.ts").FixtureEntry>,
  second: Record<string, import("./testing/fixture-repo.ts").FixtureEntry>,
) {
  return makeFixtureRepo(repoDir(), { commits: [first, second], branches: { old: 0 } });
}

/** A source pinned at commit 0 whose branch then follows main, which is at commit 1. */
async function addedAtOld(s: Setup, skills: string[]) {
  const p = await preview(s, { branch: "old" });
  const { source } = await s.svc.add(ghBody(p.previewId as string, skills), OR);
  await s.store.update(source.id, { branch: "main" });
  return source;
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

describe("preview", () => {
  test("lists every subfolder with its reason", async () => {
    mkdirSync(path.join(claude, "skills", "dup"), { recursive: true });
    writeFileSync(path.join(claude, "skills", "dup", "SKILL.md"), md("dup"));
    await makeFixtureRepo(repoDir(), {
      commits: [
        {
          "tdd/SKILL.md": md("tdd"),
          "dup/SKILL.md": md("dup"),
          "other/SKILL.md": md("not-other"),
          "no-skill/README.md": "x",
        },
      ],
    });
    const s = setup();
    const p = await preview(s);
    expect(p.previewId).toBeTruthy();
    expect(p.found.map((f) => [f.name, f.pickable, f.reason, f.takenBy, f.detail])).toEqual([
      ["dup", false, "taken", "Host", undefined],
      ["other", true, undefined, undefined, undefined],
      ["tdd", true, undefined, undefined, undefined],
    ]);
  });

  test("a name another source holds is taken by that source", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    const s = setup();
    await s.svc.add(ghBody((await preview(s)).previewId as string, ["tdd"]), OR);
    const again = await preview(s);
    expect(again.found).toMatchObject([
      { name: "tdd", pickable: false, reason: "taken", takenBy: "acme/x" },
    ]);
  });

  test("a folder lists links and a one-skill folder is one skill", async () => {
    const dir = path.join(tmp, "skills");
    mkdirSync(path.join(dir, "real"), { recursive: true });
    writeFileSync(path.join(dir, "real", "SKILL.md"), md("real"));
    mkdirSync(path.join(tmp, "elsewhere"));
    writeFileSync(path.join(tmp, "elsewhere", "SKILL.md"), md("lnk"));
    symlinkSync(path.join(tmp, "elsewhere"), path.join(dir, "lnk"));
    const s = setup();
    expect((await s.svc.preview({ kind: "folder", path: dir }, OR)).found).toMatchObject([
      { name: "lnk", pickable: false, reason: "link" },
      { name: "real", pickable: true },
    ]);
    const one = await s.svc.preview({ kind: "folder", path: path.join(dir, "real") }, OR);
    expect(one.found).toMatchObject([{ name: "real", pickable: true }]);
  });

  test("a folder preview of the home folder is a field error", async () => {
    const s = setup();
    const e = await s.svc.preview({ kind: "folder", path: "~" }, OR).catch((x) => x);
    expect(e).toMatchObject({ extra: { fields: { path: MSG.folderHome } } });
  });

  test("a repo over 50 MB is a form-level too_large error, with no field", async () => {
    await makeFixtureRepo(repoDir(), {
      commits: [{ "tdd/SKILL.md": md("tdd"), big: { bytes: 51 * 1024 * 1024 } }],
    });
    const e = await expectApi(preview(setup()), 400, "too_large");
    expect(e.message).toBe("Folder is over 50 MB.");
    expect(e.extra).toEqual({});
  });

  test("a repo that returns another commit is a form-level commit_mismatch error, with no field", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    // runGit spawns "git" from PATH: a wrapper named git, first on PATH, lies about HEAD.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const real = process.env.PATH;
    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = rev-parse ]; then echo ${"b".repeat(40)}; exit 0; fi; done\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(path.join(binDir, "git"), 0o755);
    process.env.PATH = `${binDir}:${real}`;
    try {
      const e = await expectApi(preview(setup()), 400, "commit_mismatch");
      expect(e.message).toBe("The repo returned another commit.");
      expect(e.extra).toEqual({});
    } finally {
      process.env.PATH = real;
    }
  });

  test("a missing branch is a branch field error", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    const e = await preview(setup(), { branch: "nope" }).catch((x) => x);
    expect(e).toMatchObject({ extra: { fields: { branch: MSG.branchMissing } } });
  });
});

describe("add", () => {
  test("refuses a name taken after the preview", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    const s = setup();
    const p = (await preview(s)).previewId as string;
    // Taken after the preview: a host skill appears before the add.
    mkdirSync(path.join(claude, "skills", "tdd"), { recursive: true });
    writeFileSync(path.join(claude, "skills", "tdd", "SKILL.md"), md("tdd"));
    await expectApi(s.svc.add(ghBody(p, ["tdd"]), OR), 409, "name_taken");
  });

  test("a folder add refuses a name a source holds", async () => {
    const dir = path.join(tmp, "skills");
    mkdirSync(path.join(dir, "a"), { recursive: true });
    writeFileSync(path.join(dir, "a", "SKILL.md"), md("a"));
    const s = setup();
    const added = await s.svc.add({ kind: "folder", path: dir, skills: ["a"] }, OR);
    expect(added).toMatchObject({
      status: 201,
      source: { kind: "folder", skills: ["a"], state: "ready" },
    });
    await expectApi(s.svc.add({ kind: "folder", path: dir, skills: ["a"] }, OR), 409, "name_taken");
  });

  test("a live preview installs the pin read-only and records the trees", async () => {
    await makeFixtureRepo(repoDir(), {
      commits: [{ "tdd/SKILL.md": md("tdd"), "other/SKILL.md": md("other") }],
    });
    const s = setup();
    const p = await preview(s);
    const { status, source } = await s.svc.add(ghBody(p.previewId as string, ["tdd"]), ANA);
    expect(status).toBe(201);
    expect(source).toMatchObject({ state: "ready", skills: ["tdd"], pin: p.commit });
    const row = (await s.store.all())[0] as SkillSourceRow;
    expect(row.addedById).toBe(ANA.id);
    expect(Object.keys(row.trees ?? {})).toEqual(["tdd"]);
    const dest = path.join(fh, "state/library/github", row.id, p.commit as string);
    expect(existsSync(path.join(dest, "tdd/SKILL.md"))).toBe(true);
    expect(statSync(path.join(dest, "tdd/SKILL.md")).mode & 0o222).toBe(0);
    // The preview was consumed.
    await expect(s.svc.add(ghBody(p.previewId as string, ["tdd"]), ANA)).rejects.toMatchObject({
      extra: { fields: { previewId: expect.any(String) } },
    });
  });

  test("an expired preview re-fetches the pin and answers 202", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    const s = setup();
    const p = await preview(s);
    rmSync(path.join(fh, "state/library/preview", p.previewId as string), {
      recursive: true,
      force: true,
    });
    const { status, source } = await s.svc.add(ghBody(p.previewId as string, ["tdd"]), OR);
    expect([status, source.state]).toEqual([202, "adding"]);
    await s.svc.idle();
    const row = (await s.store.all())[0] as SkillSourceRow;
    expect(row.state).toBe("ready");
    expect(
      existsSync(path.join(fh, "state/library/github", row.id, p.commit as string, "tdd/SKILL.md")),
    ).toBe(true);
    expect(Object.keys(row.trees ?? {})).toEqual(["tdd"]);
    expect(s.frames).toHaveLength(2);
    expect(s.frames.some((f) => f?.addFailed !== undefined)).toBe(false);
  });

  test("a re-fetch that fails removes the adding row", async () => {
    await makeFixtureRepo(repoDir(), { commits: [{ "tdd/SKILL.md": md("tdd") }] });
    const s = setup();
    const p = await preview(s);
    rmSync(path.join(fh, "state/library/preview", p.previewId as string), {
      recursive: true,
      force: true,
    });
    rmSync(repoDir(), { recursive: true, force: true });
    await s.svc.add(ghBody(p.previewId as string, ["tdd"]), OR);
    await s.svc.idle();
    expect(await s.store.all()).toEqual([]);
    // The web learns of the failure from the frame (a toast), since the row is gone.
    expect(s.frames.at(-1)).toEqual({ addFailed: "acme/x" });
  });
});

describe("check and update", () => {
  const A = { "tdd/SKILL.md": md("tdd"), "lint/SKILL.md": md("lint"), "gone/SKILL.md": md("gone") };

  test("check stores the update and a failing check stores the error", async () => {
    const r = await twoCommitRepo(A, { ...A, "tdd/SKILL.md": md("tdd", "x: 1\n") });
    const s = setup();
    const src = await addedAtOld(s, ["tdd"]);
    const checked = await s.svc.check(src.id);
    expect(checked).toMatchObject({
      updateCommit: r.shas[1],
      updateSubject: "commit 2",
      checkError: null,
    });
    expect(checked.checkedAt).toBe(new Date(nowMs).toISOString());
    await s.store.update(src.id, { repo: "nobody/none" });
    const failed = await s.svc.check(src.id);
    expect(failed.checkError).toMatch(/^git failed/);
    expect(failed.updateCommit).toBe(r.shas[1]);
  });

  test("the update view reports what changed from the trees", async () => {
    await twoCommitRepo(A, {
      ...A,
      "tdd/SKILL.md": md("tdd", "x: 1\n"),
      "gone/SKILL.md": md("gone"),
      "extra/SKILL.md": md("extra"),
    });
    const s = setup();
    const src = await addedAtOld(s, ["gone", "lint", "tdd"]);
    await s.svc.check(src.id);
    const v = await s.svc.updateView(src.id);
    expect(v.changed.map((c) => c.name)).toEqual(["tdd"]);
    expect(v.removed).toEqual([]);
    expect(v.added).toEqual(["extra"]);
    expect(v.compareUrl).toBeUndefined();
  });

  test("a skill that gains hooks or executables is flagged runs-code-changed", async () => {
    await twoCommitRepo(
      { ...A, "lint/run.sh": { exec: "echo 1" }, "gone/SKILL.md": md("gone", hookFm("old.sh")) },
      {
        "tdd/SKILL.md": md("tdd", hookFm("new.sh")),
        "lint/SKILL.md": md("lint"),
        "lint/run.sh": { exec: "echo 2" },
        "gone/SKILL.md": md("gone"),
        "notes/SKILL.md": md("notes"),
      },
    );
    const s = setup();
    const src = await addedAtOld(s, ["gone", "lint", "tdd"]);
    await s.svc.check(src.id);
    const v = await s.svc.updateView(src.id);
    expect(v.changed.map((c) => [c.name, c.runsCodeChanged, c.execFiles])).toEqual([
      ["lint", true, ["run.sh"]],
      ["tdd", true, []],
      ["gone", false, []],
    ]);
    expect(v.changed.find((c) => c.name === "tdd")?.hooks).toEqual({
      added: [{ event: "PreToolUse", matcher: "Bash", command: "new.sh" }],
      removed: [],
    });
    expect(v.changed.find((c) => c.name === "gone")?.hooks.removed).toEqual([
      { event: "PreToolUse", matcher: "Bash", command: "old.sh" },
    ]);
  });

  test("an update drops an unused removed skill and calls libraryChanged after the lock", async () => {
    const r = await twoCommitRepo(A, {
      "tdd/SKILL.md": md("tdd", "x: 1\n"),
      "lint/SKILL.md": md("lint"),
    });
    const s = setup();
    const src = await addedAtOld(s, ["gone", "lint", "tdd"]);
    await s.svc.check(src.id);
    const upd = await s.svc.update(src.id, r.shas[1] as string, ANA);
    expect(upd).toMatchObject({ pin: r.shas[1], skills: ["lint", "tdd"], updateCommit: null });
    const row = (await s.store.all())[0] as SkillSourceRow;
    expect(Object.keys(row.trees ?? {})).toEqual(["lint", "tdd"]);
    expect(
      existsSync(
        path.join(fh, "state/library/github", row.id, r.shas[1] as string, "tdd/SKILL.md"),
      ),
    ).toBe(true);
    expect(s.changed).toEqual([
      {
        skills: ["gone", "lint", "tdd"],
        by: `<@${ANA.ref}>`,
        before: {
          skills: { gone: "captured", lint: "captured", tdd: "captured" },
        },
      },
    ]);
    expect(s.captured).toEqual([src.pin]);
    expect(s.lockFreeInCallback).toEqual([true]);
    expect(s.publishDepth.at(-1)).toBe(0);
  });

  test("an update that would remove a used skill names at most three users", async () => {
    const r = await twoCommitRepo(A, { "tdd/SKILL.md": md("tdd"), "lint/SKILL.md": md("lint") });
    const s = setup({
      users: { gone: { templates: ["dev"], agents: ["ana", "bob", "cy", "di"] } },
    });
    const src = await addedAtOld(s, ["gone", "tdd"]);
    await s.svc.check(src.id);
    const e = await expectApi(
      s.svc.update(src.id, r.shas[1] as string, OR),
      409,
      "update_drops_used",
    );
    expect(e.message).toBe(
      "Update would remove skill gone, used by template dev, @ana, @bob and 2 more.",
    );
    expect(e.extra).toEqual({
      skills: ["gone"],
      templates: ["dev"],
      agents: ["ana", "bob", "cy", "di"],
    });
    expect((await s.store.all())[0]?.commit).toBe(r.shas[0]);
    expect(s.changed).toEqual([]);
  });

  test("an update that would leave no skill is refused", async () => {
    const r = await twoCommitRepo(A, { "lint/SKILL.md": md("lint") });
    const s = setup();
    const src = await addedAtOld(s, ["tdd"]);
    await s.svc.check(src.id);
    const e = await expectApi(s.svc.update(src.id, r.shas[1] as string, OR), 409, "empties_source");
    expect(e.message).toBe(
      "This update removes every skill you picked. Remove the source instead.",
    );
  });

  test("an update names the commit the check found, nothing else", async () => {
    const r = await twoCommitRepo(A, A);
    const s = setup();
    const src = await addedAtOld(s, ["tdd"]);
    await expectApi(s.svc.update(src.id, r.shas[1] as string, OR), 409, "stale_update");
  });

  test("refetch restores a cache that went missing", async () => {
    await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    const p = await preview(s);
    const { source } = await s.svc.add(ghBody(p.previewId as string, ["tdd"]), OR);
    const dest = path.join(fh, "state/library/github", source.id, p.commit as string);
    await removeTree(dest);
    expect(existsSync(dest)).toBe(false);
    await s.svc.refetch(source.id);
    expect(existsSync(path.join(dest, "tdd/SKILL.md"))).toBe(true);
  });

  test("checkAll never runs more than four checks at once", async () => {
    await twoCommitRepo(A, { ...A, "tdd/SKILL.md": md("tdd", "x: 1\n") });
    const s = setup();
    const sha0 = (
      await runGit(["rev-parse", "old"], { cwd: repoDir(), allowFile: true })
    ).stdout.trim();
    for (let i = 0; i < 8; i++) {
      await s.store.insert({
        id: `00000000-0000-4000-8000-00000000000${i}`,
        kind: "github",
        path: null,
        repo: "acme/x",
        subpath: "",
        branch: "main",
        commit: sha0,
        committedAt: null,
        subject: null,
        trees: null,
        updateCommit: null,
        updateAt: null,
        updateSubject: null,
        checkedAt: null,
        checkError: null,
        skills: [`s${i}`],
        state: "ready",
        startedAt: new Date(nowMs),
        addedById: "u-or",
        addedAt: new Date(nowMs + i),
        deletedAt: null,
      });
    }
    gate.delayMs = 15;
    gate.max = 0;
    await s.svc.checkAll();
    expect(gate.max).toBe(4);
    expect(
      (await s.store.all()).every((r) => r.checkedAt !== null && r.updateCommit !== null),
    ).toBe(true);
  });
});

describe("find more skills", () => {
  test("a new skill at the pin can be added with its tree", async () => {
    await makeFixtureRepo(repoDir(), {
      commits: [{ "tdd/SKILL.md": md("tdd"), "lint/SKILL.md": md("lint") }],
    });
    const s = setup();
    const { source } = await s.svc.add(ghBody((await preview(s)).previewId as string, ["tdd"]), OR);
    const found = await s.svc.find(source.id);
    expect(found.found.map((f) => [f.name, f.pickable])).toEqual([
      ["lint", true],
      ["tdd", false],
    ]);
    const next = await s.svc.addSkills(source.id, ["lint"], OR);
    expect(next.skills).toEqual(["lint", "tdd"]);
    expect(Object.keys((await s.store.all())[0]?.trees ?? {}).sort()).toEqual(["lint", "tdd"]);
  });
});

describe("remove and restore", () => {
  async function folderSource(s: Setup, name = "a") {
    const dir = path.join(tmp, `skills-${name}`);
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "SKILL.md"), md(name));
    return (await s.svc.add({ kind: "folder", path: dir, skills: [name] }, OR)).source;
  }

  test("remove is refused while the source is used, naming at most three users", async () => {
    const s = setup({ users: { a: { templates: ["dev", "ops"], agents: ["ana", "bob"] } } });
    const src = await folderSource(s);
    const e = await expectApi(s.svc.remove(src.id), 409, "in_use");
    expect(e.message).toBe("Used by template dev, template ops, @ana and 1 more.");
    expect(e.extra).toEqual({ templates: ["dev", "ops"], agents: ["ana", "bob"] });
    expect((await s.store.all())[0]?.deletedAt).toBeNull();
  });

  test("an unused source is soft deleted with a 30 s Undo window", async () => {
    const s = setup();
    const src = await folderSource(s);
    const { undoUntil } = await s.svc.remove(src.id);
    expect(undoUntil).toBe(new Date(nowMs + 30_000).toISOString());
    expect((await s.store.all())[0]?.deletedAt).toEqual(new Date(nowMs));
    await expectApi(s.svc.check(src.id), 404, "not_found");
  });

  test("restore works within 30 s and calls libraryChanged", async () => {
    const s = setup();
    const src = await folderSource(s);
    await s.svc.remove(src.id);
    nowMs += 29_999;
    expect(await s.svc.restore(src.id, ANA)).toMatchObject({ id: src.id, skills: ["a"] });
    expect((await s.store.all())[0]?.deletedAt).toBeNull();
    expect(s.changed).toEqual([
      { skills: ["a"], by: `<@${ANA.ref}>`, before: { skills: { a: "captured" } } },
    ]);
    expect(s.lockFreeInCallback).toEqual([true]);
    expect(s.publishDepth).toEqual([0, 0, 0]);
  });

  test("restore is refused after 30 s", async () => {
    const s = setup();
    const src = await folderSource(s);
    await s.svc.remove(src.id);
    nowMs += 30_000;
    await expectApi(s.svc.restore(src.id, ANA), 409, "undo_over");
    expect((await s.store.all())[0]?.deletedAt).not.toBeNull();
  });

  test("restore is refused once another source took a name", async () => {
    const s = setup();
    const first = await folderSource(s);
    await s.svc.remove(first.id);
    const dir = path.join(tmp, "other");
    mkdirSync(path.join(dir, "a"), { recursive: true });
    writeFileSync(path.join(dir, "a", "SKILL.md"), md("a"));
    await s.svc.add({ kind: "folder", path: dir, skills: ["a"] }, OR);
    await expectApi(s.svc.restore(first.id, ANA), 409, "name_taken");
  });
});

describe("races", () => {
  const A = { "tdd/SKILL.md": md("tdd"), "lint/SKILL.md": md("lint") };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a check that finishes after the pin moved doesn't write its result", async () => {
    await twoCommitRepo(A, { ...A, "tdd/SKILL.md": md("tdd", "x: 1\n") });
    const s = setup();
    const src = await addedAtOld(s, ["tdd"]);
    gate.delayMs = 40;
    const running = s.svc.check(src.id);
    await sleep(15);
    await s.store.update(src.id, { commit: "f".repeat(40) });
    await running;
    const row = (await s.store.all())[0] as SkillSourceRow;
    expect([row.updateCommit, row.checkedAt]).toEqual([null, null]);
  });

  test("adding skills after the pin moved is refused as stale", async () => {
    await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    const { source } = await s.svc.add(ghBody((await preview(s)).previewId as string, ["tdd"]), OR);
    gate.delayMs = 40;
    const running = expectApi(s.svc.addSkills(source.id, ["lint"], OR), 409, "pin_moved");
    await sleep(15);
    await s.store.update(source.id, { commit: "f".repeat(40) });
    await running;
    expect((await s.store.all())[0]?.skills).toEqual(["tdd"]);
  });

  test("adding a skill the pin doesn't have is a 400, not a git failure", async () => {
    await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    const { source } = await s.svc.add(ghBody((await preview(s)).previewId as string, ["tdd"]), OR);
    await expectApi(s.svc.addSkills(source.id, ["nope"], OR), 400, "validation_error");
  });

  test("a failed re-fetch leaves a row that was meanwhile made ready", async () => {
    await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    const p = await preview(s);
    rmSync(path.join(fh, "state/library/preview", p.previewId as string), {
      recursive: true,
      force: true,
    });
    gate.delayMs = 40;
    await s.svc.add(ghBody(p.previewId as string, ["tdd"]), OR);
    await sleep(15);
    const id = (await s.store.all())[0]?.id as string;
    rmSync(repoDir(), { recursive: true, force: true });
    await s.store.update(id, { state: "ready" });
    await s.svc.idle();
    expect((await s.store.all()).map((r) => r.id)).toEqual([id]);
  });
});

describe("update view and update edge cases", () => {
  const base = {
    "tdd/SKILL.md": md("tdd"),
    "lint/SKILL.md": md("lint"),
    "gone/SKILL.md": md("gone"),
  };

  test("lists removed skills at the new commit", async () => {
    await twoCommitRepo(base, {
      "tdd/SKILL.md": md("tdd", "x: 1\n"),
      "lint/SKILL.md": md("lint"),
    });
    const s = setup();
    const src = await addedAtOld(s, ["gone", "lint", "tdd"]);
    await s.svc.check(src.id);
    const v = await s.svc.updateView(src.id);
    expect(v.removed).toEqual(["gone"]);
    expect(v.changed.map((c) => c.name)).toEqual(["tdd"]);
  });

  test("an update is refused when a used skill is removed", async () => {
    const r = await twoCommitRepo(base, {
      "tdd/SKILL.md": md("tdd"),
      "gone/SKILL.md": md("gone"),
    });
    const s = setup({ users: { lint: { templates: ["dev"], agents: [] } } });
    const src = await addedAtOld(s, ["lint", "tdd"]);
    await s.svc.check(src.id);
    const e = await expectApi(
      s.svc.update(src.id, r.shas[1] as string, OR),
      409,
      "update_drops_used",
    );
    expect(e.message).toBe("Update would remove skill lint, used by template dev.");
  });

  test("an executable whose bit flips with the same content is flagged", async () => {
    await twoCommitRepo(
      { ...base, "lint/run.sh": "echo 1" },
      { ...base, "lint/run.sh": { exec: "echo 1" } },
    );
    const s = setup();
    const src = await addedAtOld(s, ["lint"]);
    await s.svc.check(src.id);
    const c = (await s.svc.updateView(src.id)).changed;
    expect(c.map((x) => [x.name, x.runsCodeChanged, x.execFiles])).toEqual([
      ["lint", true, ["run.sh"]],
    ]);
  });

  test("with the old cache gone, every hook and executable counts as new", async () => {
    const files = (n: number) => ({
      ...base,
      "lint/SKILL.md": md("lint", `x: ${n}\n`),
      "lint/run.sh": { exec: "echo 1" },
    });
    await twoCommitRepo(files(0), files(1));
    const s = setup();
    const src = await addedAtOld(s, ["lint"]);
    await s.svc.check(src.id);
    expect((await s.svc.updateView(src.id)).changed[0]).toMatchObject({ runsCodeChanged: false });
    const row = (await s.store.all())[0] as SkillSourceRow;
    await removeTree(path.join(fh, "state/library/github", row.id, row.commit as string));
    expect((await s.svc.updateView(src.id)).changed[0]).toMatchObject({
      runsCodeChanged: true,
      execFiles: ["run.sh"],
    });
  });

  test("a skill with more files than the walk reads is flagged, since the rest is unread", async () => {
    const files = (n: number) => ({
      ...base,
      "lint/SKILL.md": md("lint", `x: ${n}\n`),
      "lint/a.txt": "a",
      "lint/b.txt": "b",
      "lint/c.txt": "c",
      "lint/z.txt": "z",
    });
    await twoCommitRepo(files(0), files(1));
    const walked = async (cap: number | undefined) => {
      const s = setup({ fileWalkCap: cap });
      const src = await addedAtOld(s, ["lint"]);
      await s.svc.check(src.id);
      return (await s.svc.updateView(src.id)).changed[0]?.runsCodeChanged;
    };
    expect(await walked(undefined)).toBe(false);
    expect(await walked(3)).toBe(true);
  });
});

describe("boot repair", () => {
  const A = { "tdd/SKILL.md": md("tdd") };
  const adding = (o: Partial<SkillSourceRow>): SkillSourceRow => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "github",
    path: null,
    repo: "acme/x",
    subpath: "",
    branch: "main",
    commit: "0".repeat(40),
    committedAt: null,
    subject: null,
    trees: null,
    updateCommit: null,
    updateAt: null,
    updateSubject: null,
    checkedAt: null,
    checkError: null,
    skills: ["tdd"],
    state: "adding",
    startedAt: new Date(nowMs),
    addedById: "u-or",
    addedAt: new Date(nowMs),
    deletedAt: null,
    ...o,
  });

  test("finishes an interrupted add", async () => {
    const r = await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    await s.store.insert(adding({ commit: r.shas[0] }));
    s.svc.repairInBackground();
    await s.svc.idle();
    const row = (await s.store.all())[0] as SkillSourceRow;
    expect([row.state, Object.keys(row.trees ?? {})]).toEqual(["ready", ["tdd"]]);
    expect(
      existsSync(
        path.join(fh, "state/library/github", row.id, r.shas[0] as string, "tdd/SKILL.md"),
      ),
    ).toBe(true);
  });

  test("removes an add that can't finish", async () => {
    await makeFixtureRepo(repoDir(), { commits: [A] });
    const s = setup();
    await s.store.insert(adding({ commit: "0".repeat(40) }));
    await s.svc.bootRepair();
    expect(await s.store.all()).toEqual([]);
    expect(s.logged.length).toBeGreaterThan(0);
  });

  describe("the checking mark", () => {
    async function sources(s: Setup, n: number) {
      await twoCommitRepo(A, { ...A, "tdd/SKILL.md": md("tdd", "x: 1\n") });
      const sha0 = (
        await runGit(["rev-parse", "old"], { cwd: repoDir(), allowFile: true })
      ).stdout.trim();
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = `00000000-0000-4000-8000-00000000000${i}`;
        ids.push(id);
        await s.store.insert({
          id,
          kind: "github",
          path: null,
          repo: "acme/x",
          subpath: "",
          branch: "main",
          commit: sha0,
          committedAt: null,
          subject: null,
          trees: null,
          updateCommit: null,
          updateAt: null,
          updateSubject: null,
          checkedAt: null,
          checkError: null,
          skills: [`s${i}`],
          state: "ready",
          startedAt: new Date(nowMs),
          addedById: "u-or",
          addedAt: new Date(nowMs + i),
          deletedAt: null,
        });
      }
      return ids;
    }

    test("a check marks its source from when it starts, and the frame goes out after the mark is cleared", async () => {
      const s = setup();
      const [id = ""] = await sources(s, 1);
      const seen: (string | undefined)[] = [];
      const push = s.frames.push.bind(s.frames);
      s.frames.push = (e) => {
        seen.push(s.svc.checkingSince(id));
        return push(e);
      };
      expect(s.svc.checkingSince(id)).toBeUndefined();
      const p = s.svc.check(id);
      expect(s.svc.checkingSince(id)).toBe(new Date(nowMs).toISOString());
      // A frame went out at the start, so the list shows the row as checking.
      expect(seen).toEqual([new Date(nowMs).toISOString()]);
      await p;
      expect(s.svc.checkingSince(id)).toBeUndefined();
      // And one after the mark was cleared, so a refetch sees the result.
      expect(seen).toEqual([new Date(nowMs).toISOString(), undefined]);
    });

    test("a check that throws still clears the mark and publishes", async () => {
      const s = setup();
      await expect(s.svc.check("00000000-0000-4000-8000-0000000000ff")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(s.svc.checkingSince("00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
      expect(s.frames).toHaveLength(2);
    });

    test("checking every source marks the whole queue at once, not four at a time, and publishes at the start and after each", async () => {
      const s = setup();
      const ids = await sources(s, 6);
      gate.delayMs = 15;
      await s.svc.startCheckAll();
      // Six queued, four run at a time: all six are marked before the request that started them returns.
      expect(ids.map((id) => s.svc.checkingSince(id))).toEqual(
        ids.map(() => new Date(nowMs).toISOString()),
      );
      expect(s.frames).toHaveLength(1);
      await s.svc.idle();
      expect(ids.map((id) => s.svc.checkingSince(id))).toEqual(ids.map(() => undefined));
      expect(s.frames).toHaveLength(1 + 6);
    });

    test("a second Check for updates while one runs leaves the running one's marks alone and checks nothing twice", async () => {
      const s = setup();
      const ids = await sources(s, 6);
      gate.delayMs = 15;
      await s.svc.startCheckAll();
      const first = ids.map((id) => s.svc.checkingSince(id));
      nowMs += 60_000;
      await s.svc.startCheckAll();
      // The first run's marks are untouched (not re-stamped), and the second run queued nothing.
      expect(ids.map((id) => s.svc.checkingSince(id))).toEqual(first);
      expect(s.frames).toHaveLength(1);
      await s.svc.idle();
      expect(ids.map((id) => s.svc.checkingSince(id))).toEqual(ids.map(() => undefined));
      // One start frame, then one per source: six checks, not twelve.
      expect(s.frames).toHaveLength(1 + 6);
    });

    test("a source that is still adding is not marked and does not hold the check back", async () => {
      const s = setup();
      const ids = await sources(s, 2);
      await s.store.update(ids[1] as string, { state: "adding" });
      await s.svc.startCheckAll();
      expect(s.svc.checkingSince(ids[0] as string)).toBeDefined();
      expect(s.svc.checkingSince(ids[1] as string)).toBeUndefined();
      await s.svc.idle();
      expect(s.svc.checkingSince(ids[0] as string)).toBeUndefined();
    });
  });
});
