import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { folderSource, hostOnlyLibrary, writeHostSkill } from "../test/library.ts";
import {
  linkProjects,
  linkSkills,
  resolveSkills,
  resolveTemplateSkills,
  WorkspaceError,
} from "./links.ts";

const link = (
  workdir: string,
  library: Parameters<typeof linkSkills>[1],
  template: Parameters<typeof linkSkills>[2],
  opts: { checkOnly?: boolean; prefixes?: string[] } = {},
) => linkSkills(workdir, library, template, { prefixes: [], ...opts });

const noTpl = () => ({ templateDir: tmp("notpl-"), skills: [] });

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

/** A Library over `<claude>/skills` for resolving the names these tests link. */
function hostLib() {
  const claude = realpathSync(tmp("claude-"));
  const factory = tmp("factory-");
  return { claude, hs: path.join(claude, "skills"), lib: hostOnlyLibrary(claude, factory) };
}
const prefixesOf = (lib: ReturnType<typeof hostLib>["lib"]) => lib.linkPrefixes();

test("Library skills: resolved to real folders, linked, stale links removed, non-links never touched", async () => {
  const { claude, hs, lib } = hostLib();
  writeHostSkill(claude, "grilling");
  writeHostSkill(claude, "old");
  const real = realpathSync(tmp("real-"));
  writeFileSync(path.join(real, "SKILL.md"), "---\nname: linked\n---\n");
  symlinkSync(real, path.join(hs, "linked"));
  const wd = tmp("wd-");
  mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
  symlinkSync(path.join(hs, "old"), path.join(wd, ".claude/skills/old"));
  mkdirSync(path.join(wd, ".claude/skills/local-one"));
  const skills = await resolveSkills(lib, ["grilling", "linked"]);
  expect(skills).toEqual([
    { name: "grilling", dir: path.join(hs, "grilling") },
    { name: "linked", dir: real },
  ]);
  await link(wd, skills, noTpl(), { prefixes: await prefixesOf(lib) });
  expect(readlinkSync(path.join(wd, ".claude/skills/grilling"))).toBe(path.join(hs, "grilling"));
  expect(readlinkSync(path.join(wd, ".claude/skills/linked"))).toBe(real);
  expect(existsSync(path.join(wd, ".claude/skills/old"))).toBe(false);
  expect(lstatSync(path.join(wd, ".claude/skills/local-one")).isDirectory()).toBe(true);
  writeHostSkill(claude, "grilling2");
  mkdirSync(path.join(wd, ".claude/skills/grilling2"));
  await expect(
    link(wd, await resolveSkills(lib, ["grilling2"]), noTpl(), { prefixes: [] }),
  ).rejects.toBeInstanceOf(WorkspaceError);
});

test("resolveSkills fails with the Library's reason as the start's message, fixed in Configuration", async () => {
  const { claude, lib } = hostLib();
  await expect(resolveSkills(lib, ["nope"])).rejects.toMatchObject({
    name: "WorkspaceError",
    message: "Skill nope hasn't been added in Skills. Fix it in Configuration.",
    diagnosis: "Skill nope hasn't been added in Skills.",
    fix: "config",
  });
  // A name the template itself lists is the template's to fix.
  await expect(resolveSkills(lib, ["nope"], ["nope"])).rejects.toMatchObject({
    message: "Skill nope hasn't been added in Skills. Fix it in Templates.",
    diagnosis: "Skill nope hasn't been added in Skills.",
    fix: "template",
  });
  await expect(resolveSkills(lib, ["nope"], ["other"])).rejects.toMatchObject({ fix: "config" });
  const missing = {
    resolveSkill: async () => ({ ok: false as const, reason: "missing" as const }),
  };
  await expect(resolveSkills(missing, ["gone"])).rejects.toMatchObject({
    diagnosis: "Skill gone is missing from its folder.",
  });
});

test("the drop-unlisted pass removes links under every known prefix and leaves a real folder and a foreign link", async () => {
  const claude = realpathSync(tmp("claude-"));
  const factory = realpathSync(tmp("factory-"));
  const folder = realpathSync(tmp("src-"));
  writeHostSkill(claude, "h");
  const mine = path.join(folder, "f");
  mkdirSync(mine);
  writeFileSync(path.join(mine, "SKILL.md"), "---\nname: f\n---\n");
  const gh = path.join(factory, "state/library/github/id1/abc/g");
  mkdirSync(gh, { recursive: true });
  const lib = hostOnlyLibrary(claude, factory, [folderSource(folder, ["f"])]);
  const wd = tmp("wd-");
  const sk = path.join(wd, ".claude/skills");
  mkdirSync(sk, { recursive: true });
  const foreign = realpathSync(tmp("foreign-"));
  symlinkSync(path.join(claude, "skills/h"), path.join(sk, "host"));
  symlinkSync(mine, path.join(sk, "folder"));
  symlinkSync(gh, path.join(sk, "github"));
  symlinkSync(foreign, path.join(sk, "foreign"));
  mkdirSync(path.join(sk, "real"));
  await link(wd, [], noTpl(), { prefixes: await prefixesOf(lib) });
  expect(readdirSync(sk).sort()).toEqual(["foreign", "real"]);
});

test("projects: created, retargeted, revoked removed; missing folder fails; checkOnly writes nothing", async () => {
  const a = tmp("a-");
  const b = tmp("b-");
  const wd = tmp("wd-");
  await linkProjects(wd, [
    { name: "app", hostPath: a },
    { name: "web", hostPath: b },
  ]);
  await linkProjects(wd, [{ name: "app", hostPath: b }]);
  expect(readlinkSync(path.join(wd, "projects/app"))).toBe(b);
  expect(existsSync(path.join(wd, "projects/web"))).toBe(false);
  await expect(
    linkProjects(wd, [{ name: "gone", hostPath: path.join(a, "nope") }]),
  ).rejects.toThrow(/Project gone's folder .* is missing/);
  const wd2 = tmp("wd2-");
  await linkProjects(wd2, [{ name: "app", hostPath: a }], { checkOnly: true });
  expect(existsSync(path.join(wd2, "projects"))).toBe(false);
  writeFileSync(path.join(wd, "projects/real"), "x");
  await expect(linkProjects(wd, [{ name: "real", hostPath: a }])).rejects.toBeInstanceOf(
    WorkspaceError,
  );
});

test("links: an unnormalized prefix, symlinked or file parents, bad project names", async () => {
  const hs = tmp("hs-");
  mkdirSync(path.join(hs, "old"));
  const wd = tmp("wd-");
  mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
  symlinkSync(path.join(hs, "old"), path.join(wd, ".claude/skills/old"));
  await link(wd, [], noTpl(), { prefixes: [`${hs}/`] });
  expect(existsSync(path.join(wd, ".claude/skills/old"))).toBe(false);
  const outside = tmp("out-");
  const other = tmp("other-");
  symlinkSync(other, path.join(outside, "keep"));
  const wd2 = tmp("wd2-");
  symlinkSync(outside, path.join(wd2, "projects"));
  await expect(linkProjects(wd2, [])).rejects.toBeInstanceOf(WorkspaceError);
  expect(lstatSync(path.join(outside, "keep")).isSymbolicLink()).toBe(true);
  const wd3 = tmp("wd3-");
  writeFileSync(path.join(wd3, "projects"), "x");
  await expect(linkProjects(wd3, [])).rejects.toBeInstanceOf(WorkspaceError);
  await expect(
    linkProjects(tmp("wd4-"), [{ name: "../x", hostPath: other }]),
  ).rejects.toBeInstanceOf(WorkspaceError);
});

// Spec §6.4. The default layout puts FACTORY_HOME under the host home.
function tplLayout() {
  const home = realpathSync(tmp("home-"));
  const factory = path.join(home, "open-factory");
  const tplDir = path.join(factory, "templates/t");
  mkdirSync(path.join(tplDir, "skills/x"), { recursive: true });
  mkdirSync(path.join(tplDir, "skills/y"), { recursive: true });
  writeFileSync(path.join(tplDir, "skills/x/SKILL.md"), "x");
  return { home, factory, tplDir, wd: tmp("wd-") };
}

test("template skills: linked to realpath(tpl/skills)/<name>; a removed one's link goes, own folders stay", async () => {
  const { tplDir, wd } = tplLayout();
  const skills = await resolveTemplateSkills(tplDir);
  expect(skills).toEqual([
    { name: "x", realDir: path.join(tplDir, "skills/x") },
    { name: "y", realDir: path.join(tplDir, "skills/y") },
  ]);
  await link(wd, [], { templateDir: tplDir, skills });
  expect(readlinkSync(path.join(wd, ".claude/skills/x"))).toBe(path.join(tplDir, "skills/x"));
  mkdirSync(path.join(wd, ".claude/skills/mine"));
  rmSync(path.join(tplDir, "skills/y"), { recursive: true });
  await link(wd, [], { templateDir: tplDir, skills: await resolveTemplateSkills(tplDir) });
  expect(existsSync(path.join(wd, ".claude/skills/y"))).toBe(false);
  expect(lstatSync(path.join(wd, ".claude/skills/x")).isSymbolicLink()).toBe(true);
  expect(lstatSync(path.join(wd, ".claude/skills/mine")).isDirectory()).toBe(true);
  // With local_skills off, every template link goes.
  await link(wd, [], { templateDir: tplDir, skills: [] });
  expect(existsSync(path.join(wd, ".claude/skills/x"))).toBe(false);
});

test("template skills: a real folder with a template skill's name fails; a template link is refused", async () => {
  const { tplDir, wd } = tplLayout();
  mkdirSync(path.join(wd, ".claude/skills/x"), { recursive: true });
  await expect(
    link(wd, [], { templateDir: tplDir, skills: await resolveTemplateSkills(tplDir) }),
  ).rejects.toThrow(`${wd}/.claude/skills/x isn't a link to the template skill; move it away.`);
});

test("a host skill and a template skill with the same name fail the start, naming the clash", async () => {
  const { tplDir, wd } = tplLayout();
  const { claude, lib } = hostLib();
  writeHostSkill(claude, "x");
  const run = link(wd, await resolveSkills(lib, ["x"]), {
    templateDir: tplDir,
    skills: await resolveTemplateSkills(tplDir),
  });
  await expect(run).rejects.toBeInstanceOf(WorkspaceError);
  await expect(run).rejects.toMatchObject({
    message: "Skill x is both a Library skill and a template skill. Fix it in Configuration.",
    diagnosis: "Skill x is both a Library skill and a template skill.",
    fix: "config",
  });
  // Nothing was linked: the clash is found before any write.
  expect(existsSync(path.join(wd, ".claude/skills/x"))).toBe(false);
});

test("a template folder gone by the link step fails the start with the missing-template message", async () => {
  const { tplDir, wd } = tplLayout();
  rmSync(tplDir, { recursive: true });
  await expect(link(wd, [], { templateDir: tplDir, skills: [] })).rejects.toMatchObject({
    name: "WorkspaceError",
    message: "Template t no longer exists.",
  });
});

test.each([
  ["a skill entry symlinked to ~/.ssh", "entry", ".ssh", "skills/z must be a folder, not a link."],
  [
    "a skill entry symlinked to state/agents/bob",
    "entry",
    "state",
    "skills/z must be a folder, not a link.",
  ],
  ["skills/ symlinked to ~/.ssh", "dir", ".ssh", "skills/ must be a folder, not a link."],
  [
    "skills/ symlinked to state/agents/bob",
    "dir",
    "state",
    "skills/ must be a folder, not a link.",
  ],
])("resolveTemplateSkills refuses %s", async (_n, what, to, message) => {
  const { home, factory, tplDir } = tplLayout();
  const target = to === ".ssh" ? path.join(home, ".ssh") : path.join(factory, "state/agents/bob");
  mkdirSync(target, { recursive: true });
  if (what === "entry") symlinkSync(target, path.join(tplDir, "skills/z"));
  else {
    rmSync(path.join(tplDir, "skills"), { recursive: true });
    symlinkSync(target, path.join(tplDir, "skills"));
  }
  await expect(resolveTemplateSkills(tplDir)).rejects.toMatchObject({
    message,
    fix: "template",
  });
});

test("resolveTemplateSkills: a file entry is refused, hidden files and a missing skills/ are fine", async () => {
  const { tplDir } = tplLayout();
  writeFileSync(path.join(tplDir, "skills/.DS_Store"), "");
  expect((await resolveTemplateSkills(tplDir)).map((s) => s.name)).toEqual(["x", "y"]);
  writeFileSync(path.join(tplDir, "skills/README.md"), "");
  await expect(resolveTemplateSkills(tplDir)).rejects.toThrow(
    "skills/README.md must be a folder, not a link.",
  );
  expect(await resolveTemplateSkills(tmp("empty-"))).toEqual([]);
});

test("a symlinked template folder resolves to the real skills path", async () => {
  const { tplDir, factory } = tplLayout();
  const alias = path.join(factory, "templates/alias");
  symlinkSync(tplDir, alias);
  expect((await resolveTemplateSkills(alias))[0]?.realDir).toBe(path.join(tplDir, "skills/x"));
});
