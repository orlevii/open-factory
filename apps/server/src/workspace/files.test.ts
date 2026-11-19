import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  backupDiffering,
  copyTargets,
  resyncStamp,
  templateTargets,
  writeAtomic,
} from "./files.ts";

test("targets: AGENTS.md, skills (when localSkills), files/ contents at the root", async () => {
  const t = mkdtempSync(path.join(tmpdir(), "t-"));
  writeFileSync(path.join(t, "AGENTS.md"), "# A");
  mkdirSync(path.join(t, "skills/s1"), { recursive: true });
  writeFileSync(path.join(t, "skills/s1/SKILL.md"), "s");
  mkdirSync(path.join(t, "files/docs"), { recursive: true });
  writeFileSync(path.join(t, "files/docs/x.md"), "x");
  expect((await templateTargets(t, { localSkills: true })).map((x) => x.to).sort()).toEqual([
    ".claude/skills/s1/SKILL.md",
    "AGENTS.md",
    "docs/x.md",
  ]);
  expect((await templateTargets(t, { localSkills: false })).map((x) => x.to)).not.toContain(
    ".claude/skills/s1/SKILL.md",
  );
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  await copyTargets(
    t,
    wd,
    await templateTargets(t, { localSkills: true }),
    { a: 1 },
    { mcpServers: {} },
  );
  expect(readFileSync(path.join(wd, ".factory/template/settings.json"), "utf8")).toContain(
    '"a": 1',
  );
  expect(existsSync(path.join(wd, "docs/x.md"))).toBe(true);
});
test("backup only differing files; none when nothing differs; stamp has no colons", async () => {
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  writeFileSync(path.join(wd, "AGENTS.md"), "edited");
  writeFileSync(path.join(wd, "same.md"), "same");
  const stamp = resyncStamp(new Date("2026-11-19T10:22:31.123Z"));
  expect(stamp).toBe("2026-11-19T10-22-31Z");
  const dir = await backupDiffering(
    wd,
    [
      { to: "AGENTS.md", data: Buffer.from("template") },
      { to: "same.md", data: Buffer.from("same") },
      { to: "new.md", data: Buffer.from("n") },
    ],
    stamp,
  );
  expect(dir).toBe(".factory/resync/2026-11-19T10-22-31Z");
  expect(readFileSync(path.join(wd, dir as string, "AGENTS.md"), "utf8")).toBe("edited");
  expect(existsSync(path.join(wd, dir as string, "same.md"))).toBe(false);
  expect(
    await backupDiffering(wd, [{ to: "same.md", data: Buffer.from("same") }], "s2"),
  ).toBeUndefined();
  await writeAtomic(path.join(wd, "a.json"), "{}");
  expect(readFileSync(path.join(wd, "a.json"), "utf8")).toBe("{}");
});
