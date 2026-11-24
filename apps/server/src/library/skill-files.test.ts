import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  FILE_LIST_CAP,
  FILE_MSG,
  listSkillFiles,
  readSkillFile,
  readSkillMdText,
  TEXT_CAP,
} from "./skill-files.ts";

let tmp: string;
let skill: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "of-skillfiles-"));
  skill = path.join(tmp, "skill");
  mkdirSync(path.join(skill, "scripts"), { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: skill\n---\n# Skill\n");
  writeFileSync(path.join(skill, "scripts", "run.sh"), "#!/bin/sh\n");
  chmodSync(path.join(skill, "scripts", "run.sh"), 0o755);
  writeFileSync(path.join(skill, "notes.txt"), "plain\n");
  writeFileSync(path.join(tmp, "secret.txt"), "outside\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { status: number; extra: { fields?: { path?: string } } }) => e,
  );

test("the file list is sorted, marks executables and leaves out links and .git", async () => {
  symlinkSync(path.join(tmp, "secret.txt"), path.join(skill, "link.txt"));
  mkdirSync(path.join(skill, ".git"));
  writeFileSync(path.join(skill, ".git", "HEAD"), "ref");
  expect(await listSkillFiles(skill)).toEqual([
    { path: "SKILL.md", executable: false },
    { path: "notes.txt", executable: false },
    { path: "scripts/run.sh", executable: true },
  ]);
});

test("the file list stops at 2,000 entries", async () => {
  mkdirSync(path.join(skill, "many"));
  for (let i = 0; i < FILE_LIST_CAP + 5; i++) writeFileSync(path.join(skill, "many", `f${i}`), "");
  expect(await listSkillFiles(skill)).toHaveLength(FILE_LIST_CAP);
});

test("SKILL.md comes back whole when small and cut to 256 KB when large", async () => {
  expect(await readSkillMdText(skill)).toBe("---\nname: skill\n---\n# Skill\n");
  writeFileSync(path.join(skill, "SKILL.md"), "é".repeat(TEXT_CAP));
  const cut = await readSkillMdText(skill);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(TEXT_CAP);
  expect(Buffer.byteLength(cut)).toBeGreaterThan(TEXT_CAP - 4);
});

test("a SKILL.md that is a link reads as empty", async () => {
  rmSync(path.join(skill, "SKILL.md"));
  symlinkSync(path.join(tmp, "secret.txt"), path.join(skill, "SKILL.md"));
  expect(await readSkillMdText(skill)).toBe("");
});

test("reads a text file inside the skill", async () => {
  expect(await readSkillFile(skill, "scripts/run.sh")).toBe("#!/bin/sh\n");
});

test.each([
  ["../secret.txt"],
  ["/etc/passwd"],
  ["scripts/../../secret.txt"],
  ["scripts\\run.sh"],
  ["scripts"],
])("refuses the path %s", async (p) => {
  const e = await refusal(readSkillFile(skill, p));
  expect(e?.status).toBe(400);
});

test("refuses a file that is a link, and a file behind a linked folder", async () => {
  symlinkSync(path.join(tmp, "secret.txt"), path.join(skill, "link.txt"));
  symlinkSync(tmp, path.join(skill, "up"));
  expect((await refusal(readSkillFile(skill, "link.txt")))?.extra.fields?.path).toBe(FILE_MSG.link);
  expect((await refusal(readSkillFile(skill, "up/secret.txt")))?.extra.fields?.path).toBe(
    FILE_MSG.link,
  );
});

test("refuses a binary file and one over 256 KB", async () => {
  writeFileSync(path.join(skill, "a.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  writeFileSync(path.join(skill, "b.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
  writeFileSync(path.join(skill, "big.txt"), "x".repeat(TEXT_CAP + 1));
  expect((await refusal(readSkillFile(skill, "a.bin")))?.extra.fields?.path).toBe(FILE_MSG.binary);
  expect((await refusal(readSkillFile(skill, "b.bin")))?.extra.fields?.path).toBe(FILE_MSG.binary);
  expect((await refusal(readSkillFile(skill, "big.txt")))?.extra.fields?.path).toBe(
    FILE_MSG.tooLarge,
  );
});

test("a missing file is a 404", async () => {
  expect((await refusal(readSkillFile(skill, "nope.txt")))?.status).toBe(404);
});

// A FIFO with no writer blocks a plain open forever; these tests fail by timing out, not by hanging.
const posix = process.platform === "win32" ? test.skip : test;
const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([
    p,
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms)),
  ]);

posix("a SKILL.md that is a FIFO reads as empty without blocking", async () => {
  rmSync(path.join(skill, "SKILL.md"));
  execFileSync("mkfifo", [path.join(skill, "SKILL.md")]);
  expect(await within(readSkillMdText(skill))).toBe("");
});

posix(
  "a text file that is a FIFO is refused as not a file in the skill, without blocking",
  async () => {
    execFileSync("mkfifo", [path.join(skill, "pipe")]);
    const e = await within(refusal(readSkillFile(skill, "pipe")));
    expect(e).not.toBe("timed out");
    expect((e as { status: number }).status).toBe(400);
    expect((e as { extra: { fields: { path: string } } }).extra.fields.path).toBe(
      FILE_MSG.notInSkill,
    );
  },
);
