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
  const copyDir = mkdtempSync(path.join(tmpdir(), "copy-"));
  await copyTargets(
    t,
    wd,
    copyDir,
    await templateTargets(t, { localSkills: true }),
    { a: 1 },
    { mcpServers: {} },
  );
  expect(readFileSync(path.join(copyDir, "settings.json"), "utf8")).toContain('"a": 1');
  expect(existsSync(path.join(wd, "docs/x.md"))).toBe(true);
});
test("backup only differing files; none when nothing differs; stamp has no colons", async () => {
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  writeFileSync(path.join(wd, "AGENTS.md"), "edited");
  writeFileSync(path.join(wd, "same.md"), "same");
  const stamp = resyncStamp(new Date("2026-11-19T10:22:31.123Z"));
  expect(stamp).toBe("2026-11-19T10-22-31Z");
  const root = mkdtempSync(path.join(tmpdir(), "bk-"));
  const dir = await backupDiffering(
    wd,
    root,
    [
      { to: "AGENTS.md", data: Buffer.from("template") },
      { to: "same.md", data: Buffer.from("same") },
      { to: "new.md", data: Buffer.from("n") },
    ],
    stamp,
  );
  expect(dir).toBe(path.join(root, "2026-11-19T10-22-31Z"));
  expect(readFileSync(path.join(dir as string, "AGENTS.md"), "utf8")).toBe("edited");
  expect(existsSync(path.join(dir as string, "same.md"))).toBe(false);
  expect(
    await backupDiffering(wd, root, [{ to: "same.md", data: Buffer.from("same") }], "s2"),
  ).toBeUndefined();
  await writeAtomic(path.join(wd, "a.json"), "{}");
  expect(readFileSync(path.join(wd, "a.json"), "utf8")).toBe("{}");
});

import { chmodSync, lstatSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { WorkspaceError } from "./links.ts";

test("copyTargets never writes through symlinks in the destination", async () => {
  const t = mkdtempSync(path.join(tmpdir(), "t-"));
  const host = mkdtempSync(path.join(tmpdir(), "host-"));
  const repo = mkdtempSync(path.join(tmpdir(), "repo-"));
  writeFileSync(path.join(host, "SKILL.md"), "host original");
  mkdirSync(path.join(t, "skills/grilling"), { recursive: true });
  writeFileSync(path.join(t, "skills/grilling/SKILL.md"), "template");
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
  symlinkSync(host, path.join(wd, ".claude/skills/grilling"));
  await expect(
    copyTargets(
      t,
      wd,
      path.join(wd, "sc"),
      await templateTargets(t, { localSkills: true }),
      {},
      {},
    ),
  ).rejects.toBeInstanceOf(WorkspaceError);
  expect(readFileSync(path.join(host, "SKILL.md"), "utf8")).toBe("host original");

  const t2 = mkdtempSync(path.join(tmpdir(), "t-"));
  mkdirSync(path.join(t2, "files/projects/app"), { recursive: true });
  writeFileSync(path.join(t2, "files/projects/app/x"), "x");
  mkdirSync(path.join(wd, "projects"));
  symlinkSync(repo, path.join(wd, "projects/app"));
  await expect(
    copyTargets(
      t2,
      wd,
      path.join(wd, "sc"),
      await templateTargets(t2, { localSkills: false }),
      {},
      {},
    ),
  ).rejects.toThrow(/link/);
  expect(readdirSync(repo)).toEqual([]);
});

test("copyTargets: read-only re-copy, mode masked, symlink targets, no real-file clobber", async () => {
  const t = mkdtempSync(path.join(tmpdir(), "t-"));
  writeFileSync(path.join(t, "AGENTS.md"), "v1");
  chmodSync(path.join(t, "AGENTS.md"), 0o4444);
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  const targets = await templateTargets(t, { localSkills: false });
  await copyTargets(t, wd, path.join(wd, "state-copy"), targets, {}, {});
  chmodSync(path.join(t, "AGENTS.md"), 0o644);
  writeFileSync(path.join(t, "AGENTS.md"), "v2");
  chmodSync(path.join(t, "AGENTS.md"), 0o4444);
  await copyTargets(t, wd, path.join(wd, "state-copy"), targets, {}, {});
  expect(readFileSync(path.join(wd, "AGENTS.md"), "utf8")).toBe("v2");
  expect(statSync(path.join(wd, "AGENTS.md")).mode & 0o7777).toBe(0o444);
  expect(readdirSync(wd).filter((n) => n.includes(".tmp-"))).toEqual([]);

  mkdirSync(path.join(t, "files"), { recursive: true });
  symlinkSync("AGENTS.md", path.join(t, "files/link"));
  writeFileSync(path.join(wd, "link"), "precious");
  await expect(
    copyTargets(
      t,
      wd,
      path.join(wd, "sc"),
      await templateTargets(t, { localSkills: false }),
      {},
      {},
    ),
  ).rejects.toBeInstanceOf(WorkspaceError);
  expect(readFileSync(path.join(wd, "link"), "utf8")).toBe("precious");
  const wd2 = mkdtempSync(path.join(tmpdir(), "wd-"));
  await copyTargets(
    t,
    wd2,
    path.join(wd2, "sc"),
    await templateTargets(t, { localSkills: false }),
    {},
    {},
  );
  expect(lstatSync(path.join(wd2, "link")).isSymbolicLink()).toBe(true);
});

test("backupDiffering rethrows read errors and never overwrites an earlier backup", async () => {
  const wd = mkdtempSync(path.join(tmpdir(), "wd-"));
  writeFileSync(path.join(wd, "a.md"), "one");
  const inc = [{ to: "a.md", data: Buffer.from("tpl") }];
  const root = mkdtempSync(path.join(tmpdir(), "bk-"));
  const d1 = await backupDiffering(wd, root, inc, "s");
  writeFileSync(path.join(wd, "a.md"), "two");
  const d2 = await backupDiffering(wd, root, inc, "s");
  expect(d2).toBe(d1);
  const files = readdirSync(path.join(d1 as string)).sort();
  expect(files.length).toBe(2);
  expect(files.map((f) => readFileSync(path.join(d1 as string, f), "utf8")).sort()).toEqual([
    "one",
    "two",
  ]);
  mkdirSync(path.join(wd, "dir.md"));
  await expect(
    backupDiffering(wd, root, [{ to: "dir.md", data: Buffer.from("x") }], "s3"),
  ).rejects.toThrow();
});
