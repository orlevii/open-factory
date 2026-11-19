import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { linkHostSkills, linkProjects, resolveHostSkills, WorkspaceError } from "./links.ts";

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

test("host skills: resolved, linked, stale links removed, non-links never touched", async () => {
  const hs = tmp("hs-");
  mkdirSync(path.join(hs, "grilling"));
  mkdirSync(path.join(hs, "old"));
  const real = realpathSync(tmp("real-"));
  symlinkSync(real, path.join(hs, "linked"));
  const wd = tmp("wd-");
  mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
  symlinkSync(path.join(hs, "old"), path.join(wd, ".claude/skills/old"));
  mkdirSync(path.join(wd, ".claude/skills/local-one"));
  const skills = await resolveHostSkills(hs, ["grilling", "linked"]);
  expect(skills.find((s) => s.name === "linked")?.realDir).toBe(real);
  await linkHostSkills(wd, hs, skills);
  expect(readlinkSync(path.join(wd, ".claude/skills/grilling"))).toBe(path.join(hs, "grilling"));
  expect(existsSync(path.join(wd, ".claude/skills/old"))).toBe(false);
  expect(lstatSync(path.join(wd, ".claude/skills/local-one")).isDirectory()).toBe(true);
  await expect(resolveHostSkills(hs, ["missing"])).rejects.toThrow(
    `Host skill missing is missing from ${hs}.`,
  );
  mkdirSync(path.join(wd, ".claude/skills/grilling2"));
  mkdirSync(path.join(hs, "grilling2"));
  await expect(
    linkHostSkills(wd, hs, await resolveHostSkills(hs, ["grilling2"])),
  ).rejects.toBeInstanceOf(WorkspaceError);
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
