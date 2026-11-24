import { describe, expect, test } from "vitest";
import {
  checkBranchName,
  checkGitUrl,
  cutGraphemes,
  MARKETPLACE_PATTERN,
  normalizeRepo,
  normalizeSubpath,
  PLUGIN_REF_PATTERN,
  RESERVED_MARKETPLACES,
  rowStateOf,
  skillDetailSchema,
  skillSourceAddBodySchema,
  skillSourcePreviewBodySchema,
  sourcePreviewSchema,
  sourceViewSchema,
} from "./library.ts";

const refusesMarketplace = (name: string) =>
  !MARKETPLACE_PATTERN.test(name) || RESERVED_MARKETPLACES.includes(name);

describe("normalizeRepo", () => {
  test.each(["acme/x", "https://github.com/acme/x.git", "https://github.com/acme/x"])(
    "accepts %s",
    (input) => expect(normalizeRepo(input)).toEqual({ owner: "acme", repo: "x" }),
  );

  test.each([
    "https://u:t@github.com/a/b",
    "https://github.com/a/b?x",
    "https://github.com/a/b#y",
    "git@github.com:a/b",
    "https://gitlab.com/a/b",
    "./x",
    "../x",
  ])("refuses %s", (input) => expect(normalizeRepo(input)).toBeNull());
});

describe("normalizeSubpath", () => {
  test("accepts the empty repo root", () => expect(normalizeSubpath("")).toBe(""));

  test.each(["a/../b", "/a", "./a"])("refuses %s", (input) =>
    expect(normalizeSubpath(input)).toBeNull(),
  );
});

describe("checkBranchName", () => {
  test.each(["main@{-1}", "a..b", "-x", "x.lock", "a b", "a~b", "a:b", ".hidden", "a/.b"])(
    "refuses %s",
    (name) => expect(checkBranchName(name)).toBe(false),
  );

  test.each(["main", "feature/x-1", "release.v2"])("accepts %s", (name) =>
    expect(checkBranchName(name)).toBe(true),
  );
});

describe("checkGitUrl", () => {
  test.each([
    "http://github.com/a/b.git",
    "https://u:t@github.com/a/b.git",
    "https://u@github.com/a/b.git",
    "https://@github.com/a/b.git",
    "https://github.com/a/b.git?x",
    "https://github.com/a/b.git#y",
  ])("refuses %s", (url) => expect(checkGitUrl(url)).toBe(false));

  test("accepts a plain https URL", () =>
    expect(checkGitUrl("https://git.example.com/team/tools.git")).toBe(true));
});

describe("marketplace names", () => {
  test.each(["inline", "skills-dir", "synced", "builtin", "claude-plugin-test"])(
    "refuses the reserved name %s",
    (name) => expect(refusesMarketplace(name)).toBe(true),
  );

  test("a plugin reference takes a marketplace after @", () => {
    expect(PLUGIN_REF_PATTERN.test("skill-creator@claude-plugins-official")).toBe(true);
    expect(PLUGIN_REF_PATTERN.test("no-marketplace")).toBe(false);
    expect(PLUGIN_REF_PATTERN.test(`${"a".repeat(65)}@acme`)).toBe(false);
  });
});

describe("cutGraphemes", () => {
  test("never splits a family emoji", () => {
    expect(cutGraphemes("a👩‍👩‍👧b", 2)).toBe("a…");
  });

  test("leaves a string that fits unchanged", () => expect(cutGraphemes("abc", 3)).toBe("abc"));

  test("cuts a longer string to the limit, ellipsis included", () =>
    expect(cutGraphemes("abcd", 3)).toBe("ab…"));
});

describe("rowStateOf follows the §10.2 precedence", () => {
  test.each([
    ["adding", "installing"],
    ["installing", "checking"],
    ["checking", "add_failed"],
    ["add_failed", "install_failed"],
    ["install_failed", "missing"],
    ["missing", "unusable"],
    ["unusable", "check_failed"],
    ["check_failed", "update"],
    ["update", "hidden"],
    ["hidden", "not_pinned"],
    ["not_pinned", "not_installed"],
  ] as const)("%s beats %s", (winner, loser) => {
    expect(rowStateOf([loser, winner])).toBe(winner);
  });

  test("picks the winner from unsorted input holding several states", () =>
    expect(rowStateOf(["not_installed", "update", "adding", "hidden"])).toBe("adding"));

  test("a row with no states has none to show", () => expect(rowStateOf([])).toBeUndefined());
});

describe("skill source bodies", () => {
  test("a GitHub preview takes owner/repo or a github.com URL", () => {
    expect(skillSourcePreviewBodySchema.safeParse({ kind: "github", repo: "acme/x" }).success).toBe(
      true,
    );
    const bad = skillSourcePreviewBodySchema.safeParse({
      kind: "github",
      repo: "https://u:t@github.com/a/b",
    });
    expect(bad.error?.issues[0]?.message).toBe("Use owner/repo or a github.com URL.");
  });

  test("a folder path must start with / or ~/", () =>
    expect(
      skillSourcePreviewBodySchema.safeParse({ kind: "folder", path: "code/web" }).success,
    ).toBe(false));

  test("an add picks at least one skill", () =>
    expect(
      skillSourceAddBodySchema.safeParse({ kind: "github", previewId: "p1", skills: [] }).success,
    ).toBe(false));

  test("a skill file's SKILL.md is at most 256 KB", () => {
    const detail = {
      group: "host",
      name: "review",
      description: "",
      state: "ok",
      usedBy: { templates: 0, agents: 0 },
      hooks: [],
      usedByTemplates: [],
      files: [],
    };
    expect(
      skillDetailSchema.safeParse({ ...detail, skillMd: "x".repeat(256 * 1024 + 1) }).success,
    ).toBe(false);
  });
});

describe("source responses", () => {
  const detail = {
    id: "s1",
    kind: "github",
    path: null,
    repo: "acme/x",
    subpath: "",
    branch: "main",
    pin: "a".repeat(40),
    committedAt: null,
    subject: null,
    state: "ready",
    skills: ["tdd"],
    updateCommit: "b".repeat(40),
    updateAt: null,
    updateSubject: null,
    checkedAt: null,
    checkError: null,
    usedBy: { templates: 0, agents: 0 },
  };
  const change = {
    name: "tdd",
    runsCodeChanged: true,
    hooks: { added: [{ event: "PreToolUse", matcher: "", command: "x.sh" }], removed: [] },
    execFiles: ["x.sh"],
  };
  const update = {
    from: "a".repeat(40),
    to: "b".repeat(40),
    committedAt: null,
    subject: null,
    changed: [change],
    removed: [],
    added: [],
    unusable: [],
  };

  test("a source view carries the update view, or null when there is no newer commit", () => {
    expect(sourceViewSchema.safeParse({ ...detail, update }).success).toBe(true);
    expect(sourceViewSchema.safeParse({ ...detail, update: null }).success).toBe(true);
    expect(sourceViewSchema.safeParse(detail).success).toBe(false);
  });

  test("an update view's changed skill says whether it runs different code", () => {
    const { runsCodeChanged: _r, ...bare } = change;
    expect(
      sourceViewSchema.safeParse({ ...detail, update: { ...update, changed: [bare] } }).success,
    ).toBe(false);
  });

  test("a preview marks why a skill can't be picked", () => {
    const ok = sourcePreviewSchema.safeParse({
      found: [{ name: "a", description: "", pickable: false, reason: "taken", takenBy: "Host" }],
    });
    expect(ok.success).toBe(true);
    expect(
      sourcePreviewSchema.safeParse({
        found: [{ name: "a", description: "", pickable: false, reason: "other" }],
      }).success,
    ).toBe(false);
  });
});
