import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSkillMd } from "./skill-md.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "of-skillmd-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const skill = (text: string) => {
  const dir = path.join(tmp, "foo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), text);
  return dir;
};

test("reads the name and a one-line description", async () => {
  const dir = skill("---\nname: foo\ndescription: >\n  One line\n  from two.\n---\n# Foo\n");
  expect(await readSkillMd(dir)).toEqual({
    name: "foo",
    description: "One line from two.",
    hooks: [],
  });
});

test("a description over 200 characters is cut with an ellipsis", async () => {
  const dir = skill(`---\ndescription: ${"x".repeat(300)}\n---\n`);
  const r = await readSkillMd(dir);
  expect(r?.description).toBe(`${"x".repeat(199)}…`);
});

test("a folder without SKILL.md reads as null", async () => {
  mkdirSync(path.join(tmp, "empty"));
  expect(await readSkillMd(path.join(tmp, "empty"))).toBeNull();
});

test("a symlinked SKILL.md is refused", async () => {
  const real = path.join(tmp, "real.md");
  writeFileSync(real, "---\nname: foo\n---\n");
  const dir = path.join(tmp, "foo");
  mkdirSync(dir);
  symlinkSync(real, path.join(dir, "SKILL.md"));
  expect(await readSkillMd(dir)).toBeNull();
});

test("a skill folder that is itself a link is followed", async () => {
  const dir = skill("---\nname: foo\n---\n");
  symlinkSync(dir, path.join(tmp, "alias"));
  expect((await readSkillMd(path.join(tmp, "alias")))?.name).toBe("foo");
});

test("malformed frontmatter and non-string fields give no name or description", async () => {
  expect(await readSkillMd(skill("---\ndescription: [\n---\n"))).toEqual({ hooks: [] });
  expect(await readSkillMd(skill("---\nname: 5\ndescription: 5\n---\n"))).toEqual({ hooks: [] });
  expect(await readSkillMd(skill("# no frontmatter\n"))).toEqual({ hooks: [] });
});

test("parses frontmatter hooks into event, matcher and command", async () => {
  const dir = skill(
    [
      "---",
      "name: foo",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: ./check.sh --strict",
      "  Stop:",
      "    - hooks:",
      "        - type: command",
      "          command: echo done",
      "---",
      "",
    ].join("\n"),
  );
  expect((await readSkillMd(dir))?.hooks).toEqual([
    { event: "PreToolUse", matcher: "Bash", command: "./check.sh --strict" },
    { event: "Stop", matcher: "", command: "echo done" },
  ]);
});

test("only the first 64 KB are read: frontmatter that closes after the cap is not parsed", async () => {
  const dir = skill(`---\nname: foo\nnote: ${"y".repeat(70_000)}\ndescription: late\n---\n`);
  expect(await readSkillMd(dir)).toEqual({ hooks: [] });
});

test("frontmatter inside the first 64 KB is parsed however long the body is", async () => {
  const dir = skill(`---\nname: foo\n---\n${"y".repeat(200_000)}`);
  expect((await readSkillMd(dir))?.name).toBe("foo");
});
