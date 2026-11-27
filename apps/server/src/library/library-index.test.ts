import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillSourceRow } from "@open-factory/db";
import type { ConfigDoc } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LibraryIndex, type LibraryStore, type TemplatesPort } from "./library-index.ts";

let tmp: string;
let claude: string;
let home: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-lib-")));
  claude = path.join(tmp, "claude");
  home = path.join(tmp, "home");
  mkdirSync(path.join(claude, "skills"), { recursive: true });
  mkdirSync(home);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const md = (dir: string, fm: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${fm}\n---\n# x\n`);
  return dir;
};
const host = (name: string, fm = `name: ${name}\ndescription: about ${name}`) =>
  md(path.join(claude, "skills", name), fm);

const SHA = "a".repeat(40);
const source = (o: Partial<SkillSourceRow>): SkillSourceRow => ({
  id: "11111111-1111-4111-8111-111111111111",
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
  startedAt: new Date(0),
  addedById: "u-or",
  addedAt: new Date(0),
  deletedAt: null,
  ...o,
});

interface TemplateFixture {
  skills?: string[];
  local?: string[];
}
function make(
  o: {
    sources?: SkillSourceRow[];
    templates?: Record<string, TemplateFixture>;
    agents?: { handle: string; template: string; config: unknown }[];
    checkingSince?: (id: string) => string | undefined;
  } = {},
) {
  const templates = o.templates ?? {};
  const port: TemplatesPort = {
    names: async () => Object.keys(templates).sort(),
    localSkillsOf: async (n) => templates[n]?.local ?? [],
    lastValid: async (n) =>
      templates[n]
        ? ({
            template: { skills: templates[n].skills ?? [] },
            settings: {},
            mcp: { mcpServers: {} },
          } as ConfigDoc)
        : null,
  };
  const store: LibraryStore = {
    sources: async () => o.sources ?? [],
    agents: async () => (o.agents ?? []) as Awaited<ReturnType<LibraryStore["agents"]>>,
  };
  return new LibraryIndex({
    db: undefined as never,
    store,
    hostClaudeDir: claude,
    factoryHome: home,
    templates: () => port,
    checkingSince: o.checkingSince,
  });
}

const githubDir = (id: string, ...rest: string[]) =>
  path.join(home, "state", "library", "github", id, SHA, ...rest);

test("host discovery skips zips, folders without SKILL.md and invalid names", async () => {
  host("good");
  writeFileSync(path.join(claude, "skills", "x.zip"), "z");
  mkdirSync(path.join(claude, "skills", "nomd"));
  host("bad name");
  host(".hidden");
  const groups = await make().skills();
  expect(groups[0]).toMatchObject({ group: "host", kind: "host" });
  expect(groups[0]?.skills.map((s) => s.name)).toEqual(["good"]);
  expect(groups[0]?.skills[0]).toMatchObject({ description: "about good", state: "ok" });
});

test("a frontmatter name that differs from the folder is unusable", async () => {
  host("foo", "name: bar");
  const idx = make();
  expect(await idx.resolveSkill("foo")).toEqual({
    ok: false,
    reason: "unusable",
    detail: "SKILL.md names it bar",
  });
  const row = (await idx.skills())[0]?.skills[0];
  expect(row).toMatchObject({
    name: "foo",
    state: "unusable",
    stateDetail: "SKILL.md names it bar",
  });
});

test("a host skill resolves to its realpath with ref host", async () => {
  const dir = host("alpha");
  expect(await make().resolveSkill("alpha")).toEqual({
    ok: true,
    name: "alpha",
    dir,
    ref: "host",
  });
});

test("an unknown name is not_added", async () => {
  expect(await make().resolveSkill("nope")).toEqual({ ok: false, reason: "not_added" });
});

test("a top-level host symlink is followed", async () => {
  const real = md(path.join(tmp, "elsewhere"), "name: linked");
  symlinkSync(real, path.join(claude, "skills", "linked"));
  expect(await make().resolveSkill("linked")).toMatchObject({ ok: true, dir: real });
});

test("a picked folder-source skill replaced by a link is unusable, and a deleted one is missing", async () => {
  const src = path.join(tmp, "src");
  md(path.join(src, "a"), "name: a");
  md(path.join(src, "b"), "name: b");
  const idx = make({
    sources: [source({ kind: "folder", path: src, repo: null, skills: ["a", "b"] })],
  });
  expect(await idx.resolveSkill("a")).toMatchObject({
    ok: true,
    ref: "folder",
    dir: path.join(src, "a"),
  });

  const target = md(path.join(tmp, "other"), "name: a");
  rmSync(path.join(src, "a"), { recursive: true });
  symlinkSync(target, path.join(src, "a"));
  expect(await idx.resolveSkill("a")).toEqual({
    ok: false,
    reason: "unusable",
    detail: "It's a link",
  });

  rmSync(path.join(src, "b"), { recursive: true });
  expect(await idx.resolveSkill("b")).toMatchObject({ ok: false, reason: "missing" });
});

test("a one-skill folder source resolves at the path itself", async () => {
  const src = md(path.join(tmp, "solo"), "name: solo");
  const idx = make({
    sources: [source({ kind: "folder", path: src, repo: null, skills: ["solo"] })],
  });
  expect(await idx.resolveSkill("solo")).toMatchObject({ ok: true, dir: src, ref: "folder" });
});

test("a registered GitHub skill hides the host skill of the same name and resolves to the cache", async () => {
  host("tdd");
  const s = source({});
  const dir = md(githubDir(s.id, "tdd"), "name: tdd\ndescription: from github");
  const idx = make({ sources: [s] });
  expect(await idx.resolveSkill("tdd")).toEqual({
    ok: true,
    name: "tdd",
    dir,
    ref: `github:${SHA}`,
  });
  const groups = await idx.skills();
  expect(groups.map((g) => g.group)).toEqual(["host", `source:${s.id}`]);
  expect(groups[0]?.skills[0]).toMatchObject({
    name: "tdd",
    state: "hidden",
    stateDetail: "the name is used by acme/x",
  });
  expect(groups[1]?.skills[0]).toMatchObject({
    name: "tdd",
    state: "ok",
    description: "from github",
  });
  expect(groups[1]).toMatchObject({
    kind: "source",
    source: { repo: "acme/x", pin: SHA, skillCount: 1 },
  });
});

test("a one-skill GitHub source resolves at the checkout root", async () => {
  const s = source({ skills: ["solo"] });
  const dir = md(githubDir(s.id), "name: solo");
  expect(await make({ sources: [s] }).resolveSkill("solo")).toMatchObject({ ok: true, dir });
});

test("a missing GitHub cache dir is missing, with Fetch again", async () => {
  const s = source({});
  expect(await make({ sources: [s] }).resolveSkill("tdd")).toEqual({
    ok: false,
    reason: "missing",
    detail: "Fetch again",
  });
});

test("a GitHub skill whose cache holds no code is flagged fetchAgain on its row and detail", async () => {
  const s = source({});
  const idx = make({ sources: [s] });
  const row = (await idx.skills()).find((g) => g.group === `source:${s.id}`)?.skills[0];
  expect(row).toMatchObject({ state: "missing", stateDetail: "Fetch again", fetchAgain: true });
  expect(await idx.detail(`source:${s.id}`, "tdd")).toMatchObject({ fetchAgain: true });
});

test("a missing host skill is not flagged fetchAgain", async () => {
  const idx = make({ templates: { dev: { skills: ["ghost"] } } });
  const d = await idx.detail("unknown", "ghost");
  expect(d.state).toBe("missing");
  expect(d.fetchAgain).toBeUndefined();
});

test("template-local skills form a group per template and never resolve", async () => {
  md(path.join(home, "templates", "dev", "skills", "mine"), "name: mine\ndescription: local one");
  const idx = make({ templates: { dev: { local: ["mine"] }, ops: {} } });
  const groups = await idx.skills();
  expect(groups.map((g) => g.group)).toEqual(["host", "template:dev"]);
  expect(groups[1]).toMatchObject({ kind: "template", template: "dev" });
  expect(groups[1]?.skills[0]).toMatchObject({
    name: "mine",
    description: "local one",
    state: "ok",
  });
  expect(await idx.resolveSkill("mine")).toEqual({ ok: false, reason: "not_added" });
});

test("a template-local skill has no users of its own and does not take a same-named entry's", async () => {
  host("shared");
  md(path.join(home, "templates", "dev", "skills", "shared"), "name: shared");
  const idx = make({
    templates: { dev: { local: ["shared"] }, ops: { skills: ["shared"] } },
    agents: [{ handle: "ann", template: "ops", config: {} }],
  });
  const groups = await idx.skills();
  expect(groups.map((g) => g.group)).toEqual(["host", "template:dev"]);
  expect(groups[0]?.skills[0]).toMatchObject({
    name: "shared",
    usedBy: { templates: 1, agents: 1 },
  });
  expect(groups[1]?.skills[0]).toMatchObject({
    name: "shared",
    usedBy: { templates: 0, agents: 0 },
  });
});

test("a name a template lists that resolves nowhere is in the unknown group with its users", async () => {
  host("here");
  const idx = make({
    templates: { dev: { skills: ["here", "gone"] }, ops: { skills: ["gone"] } },
    agents: [
      { handle: "ann", template: "dev", config: {} },
      { handle: "bob", template: "ops", config: { template: { skills: ["other"] } } },
      { handle: "cy", template: "ops", config: { template: { skills: ["gone"] } } },
    ],
  });
  const groups = await idx.skills();
  expect(groups.map((g) => g.group)).toEqual(["host", "unknown"]);
  const unknown = groups[1];
  expect(unknown?.skills).toEqual([
    { name: "gone", description: "", state: "missing", usedBy: { templates: 2, agents: 3 } },
    { name: "other", description: "", state: "missing", usedBy: { templates: 0, agents: 1 } },
  ]);
  expect(groups[0]?.skills[0]).toMatchObject({ name: "here", usedBy: { templates: 1, agents: 1 } });
});

test("usedBy lists templates and live agents by effective skills", async () => {
  const idx = make({
    templates: { dev: { skills: ["x"] }, ops: { skills: ["y"] } },
    agents: [
      { handle: "ann", template: "dev", config: {} },
      { handle: "bob", template: "dev", config: { template: { skills: ["y"] } } },
      { handle: "cy", template: "ops", config: { template: { skills: ["x", "y"] } } },
    ],
  });
  // Bob's own "y" adds to dev's "x".
  expect(await idx.usedBy("x")).toEqual({ templates: ["dev"], agents: ["ann", "bob", "cy"] });
  expect(await idx.usedBy("y")).toEqual({ templates: ["ops"], agents: ["bob", "cy"] });
});

test("an agent's own skill adds to its template's skills; it doesn't replace them", async () => {
  const idx = make({
    templates: { dev: { skills: ["tdd"] } },
    agents: [
      { handle: "ann", template: "dev", config: { template: { skills: ["own"] } } },
      { handle: "bob", template: "dev", config: {} },
    ],
  });
  expect(await idx.usedBy("tdd")).toEqual({ templates: ["dev"], agents: ["ann", "bob"] });
  expect(await idx.usedBy("own")).toEqual({ templates: [], agents: ["ann"] });
});

test("a host skill is Hidden only by a ready source, the same rule the resolver uses", async () => {
  host("tdd");
  const idx = make({ sources: [source({ state: "adding", skills: ["tdd"] })] });
  expect((await idx.skills())[0]?.skills[0]).toMatchObject({ name: "tdd", state: "ok" });
  expect(await idx.resolveSkill("tdd")).toMatchObject({ ok: true, ref: "host" });
  const ready = make({ sources: [source({ skills: ["tdd"] })] });
  expect((await ready.skills())[0]?.skills[0]).toMatchObject({ name: "tdd", state: "hidden" });
});

test("a host skill's detail has its row, files and SKILL.md; a link to it is followed", async () => {
  const dir = host("tdd");
  writeFileSync(path.join(dir, "notes.txt"), "n");
  const idx = make();
  const d = await idx.detail("host", "tdd");
  expect(d).toMatchObject({ group: "host", name: "tdd", state: "ok", description: "about tdd" });
  expect(d.files.map((f) => f.path)).toEqual(["SKILL.md", "notes.txt"]);
  expect(d.skillMd).toContain("# x");
  expect(d.skillMdCut).toBe(false);
  expect(await idx.fileText("host", "tdd", "notes.txt")).toBe("n");
});

test("a skill's detail carries its frontmatter hooks and its users grouped by template", async () => {
  host(
    "x",
    "name: x\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./guard.sh",
  );
  const idx = make({
    templates: { dev: { skills: ["x"] }, ops: { skills: [] } },
    agents: [
      { handle: "ann", template: "dev", config: {} },
      { handle: "cy", template: "ops", config: { template: { skills: ["x"] } } },
      { handle: "di", template: "ops", config: { template: { skills: ["x"] } } },
    ],
  });
  expect(await idx.detail("host", "x")).toMatchObject({
    hooks: [{ event: "PreToolUse", matcher: "Bash", command: "./guard.sh" }],
    usedByTemplates: [
      { name: "dev", agents: 1 },
      { name: "ops", agents: 2 },
    ],
  });
});

test("a source skill and a template-local skill resolve in their own groups", async () => {
  const s = source({});
  md(githubDir(s.id, "tdd"), "name: tdd");
  const local = md(path.join(home, "templates", "dev", "skills", "mine"), "name: mine");
  writeFileSync(path.join(local, "a.txt"), "local");
  const idx = make({ sources: [s], templates: { dev: { local: ["mine"] } } });
  expect((await idx.detail(`source:${s.id}`, "tdd")).files.map((f) => f.path)).toEqual([
    "SKILL.md",
  ]);
  expect(await idx.fileText("template:dev", "mine", "a.txt")).toBe("local");
});

test("a skill with no usable folder has no files, and a name the group lacks is a 404", async () => {
  const idx = make({ templates: { dev: { skills: ["ghost"] } } });
  expect(await idx.detail("unknown", "ghost")).toMatchObject({
    state: "missing",
    files: [],
    skillMd: "",
    skillMdCut: false,
  });
  await expect(idx.detail("host", "ghost")).rejects.toMatchObject({ status: 404 });
  await expect(idx.fileText("unknown", "ghost", "SKILL.md")).rejects.toMatchObject({ status: 404 });
});

test("a link picked inside a folder source never exposes its target's files", async () => {
  const root = path.join(tmp, "folder-src");
  md(path.join(tmp, "elsewhere"), "name: x");
  mkdirSync(root);
  symlinkSync(path.join(tmp, "elsewhere"), path.join(root, "x"));
  const idx = make({
    sources: [source({ kind: "folder", path: root, repo: null, skills: ["x"] })],
  });
  const id = "11111111-1111-4111-8111-111111111111";
  expect(await idx.detail(`source:${id}`, "x")).toMatchObject({ state: "unusable", files: [] });
  await expect(idx.fileText(`source:${id}`, "x", "SKILL.md")).rejects.toMatchObject({
    status: 404,
  });
});

test("linkPrefixes: the host folder and each host skill's real folder, folder sources, and the GitHub cache root", async () => {
  const real = realpathSync(mkdtempSync(path.join(tmpdir(), "of-lib-real-")));
  writeFileSync(path.join(real, "SKILL.md"), "---\nname: linked\n---\n");
  symlinkSync(real, path.join(claude, "skills", "linked"));
  host("plain");
  const folder = path.join(tmp, "src");
  mkdirSync(folder);
  const prefixes = await make({
    sources: [source({ kind: "folder", path: folder, repo: null, commit: null, skills: ["a"] })],
  }).linkPrefixes();
  expect(prefixes).toEqual(
    expect.arrayContaining([
      path.join(claude, "skills"),
      real,
      path.join(claude, "skills", "plain"),
      folder,
      path.join(home, "state", "library", "github"),
    ]),
  );
  expect(prefixes).not.toContain(tmp);
});

test("a source summary carries what the list needs for its state: the update, a failed check, when an add started, and a running check", async () => {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ] as const;
  const [plain, upd, failed, adding] = ids;
  const idx = make({
    sources: [
      source({ id: plain, addedAt: new Date(1) }),
      source({ id: upd, updateCommit: "b".repeat(40), addedAt: new Date(2) }),
      source({ id: failed, checkError: "git failed", addedAt: new Date(3) }),
      source({
        id: adding,
        state: "adding",
        skills: ["tdd"],
        startedAt: new Date("2026-11-24T10:00:00.000Z"),
        addedAt: new Date(4),
      }),
    ],
    checkingSince: (id) => (id === upd ? "2026-11-24T10:05:00.000Z" : undefined),
  });
  const summaries = (await idx.skills())
    .filter((g) => g.kind === "source")
    .map((g) => (g.kind === "source" ? g.source : undefined));
  expect(
    summaries.map((s) => ({
      update: s?.update,
      failed: s?.checkFailed,
      since: s?.since,
      checking: s?.checking,
    })),
  ).toEqual([
    { update: false, failed: false, since: null, checking: null },
    { update: true, failed: false, since: null, checking: { since: "2026-11-24T10:05:00.000Z" } },
    { update: false, failed: true, since: null, checking: null },
    { update: false, failed: false, since: "2026-11-24T10:00:00.000Z", checking: null },
  ]);
});
