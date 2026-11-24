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
  addedBy: "@or",
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
    agents?: { slug: string; template: string; config: unknown }[];
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

test("a folder holding .claude-plugin is unusable", async () => {
  const dir = host("plug");
  mkdirSync(path.join(dir, ".claude-plugin"));
  expect(await make().resolveSkill("plug")).toEqual({
    ok: false,
    reason: "unusable",
    detail: "It's a plugin; add it through a marketplace",
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
    agents: [{ slug: "ann", template: "ops", config: {} }],
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
      { slug: "ann", template: "dev", config: {} },
      { slug: "bob", template: "ops", config: { template: { skills: ["other"] } } },
      { slug: "cy", template: "ops", config: { template: { skills: ["gone"] } } },
    ],
  });
  const groups = await idx.skills();
  expect(groups.map((g) => g.group)).toEqual(["host", "unknown"]);
  const unknown = groups[1];
  expect(unknown?.skills).toEqual([
    { name: "gone", description: "", state: "missing", usedBy: { templates: 2, agents: 2 } },
    { name: "other", description: "", state: "missing", usedBy: { templates: 0, agents: 1 } },
  ]);
  expect(groups[0]?.skills[0]).toMatchObject({ name: "here", usedBy: { templates: 1, agents: 1 } });
});

test("usedBy lists templates and live agents by effective skills", async () => {
  const idx = make({
    templates: { dev: { skills: ["x"] }, ops: { skills: ["y"] } },
    agents: [
      { slug: "ann", template: "dev", config: {} },
      { slug: "bob", template: "dev", config: { template: { skills: ["y"] } } },
      { slug: "cy", template: "ops", config: { template: { skills: ["x", "y"] } } },
    ],
  });
  expect(await idx.usedBy("x")).toEqual({ templates: ["dev"], agents: ["ann", "cy"] });
  expect(await idx.usedBy("y")).toEqual({ templates: ["ops"], agents: ["bob", "cy"] });
});

test("a host skill's detail has its row, files and SKILL.md; a link to it is followed", async () => {
  const dir = host("tdd");
  writeFileSync(path.join(dir, "notes.txt"), "n");
  const idx = make();
  const d = await idx.detail("host", "tdd");
  expect(d).toMatchObject({ group: "host", name: "tdd", state: "ok", description: "about tdd" });
  expect(d.files.map((f) => f.path)).toEqual(["SKILL.md", "notes.txt"]);
  expect(d.skillMd).toContain("# x");
  expect(await idx.fileText("host", "tdd", "notes.txt")).toBe("n");
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
