import { describe, expect, test } from "vitest";
import {
  checkBranchName,
  cutGraphemes,
  normalizeRepo,
  normalizeSubpath,
  rowStateOf,
  skillDetailSchema,
  skillSourceAddBodySchema,
  skillSourcePreviewBodySchema,
  sourcePreviewSchema,
} from "./library.ts";
import { MSG } from "./messages.ts";

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

describe("cutGraphemes", () => {
  test("never splits a family emoji", () => {
    expect(cutGraphemes("a👩‍👩‍👧bc", 3)).toBe("a👩‍👩‍👧…");
  });

  test("leaves a string that fits unchanged", () => expect(cutGraphemes("abc", 3)).toBe("abc"));

  test("cuts a longer string to the limit, ellipsis included", () =>
    expect(cutGraphemes("abcd", 3)).toBe("ab…"));
});

describe("rowStateOf follows the §10.2 precedence", () => {
  test.each([
    ["adding", "checking"],
    ["checking", "missing"],
    ["missing", "unusable"],
    ["unusable", "check_failed"],
    ["check_failed", "update"],
    ["update", "hidden"],
  ] as const)("%s beats %s", (winner, loser) => {
    expect(rowStateOf([loser, winner])).toBe(winner);
  });

  test("picks the winner from unsorted input holding several states", () =>
    expect(rowStateOf(["update", "adding", "hidden"])).toBe("adding"));

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

  test("an add of a folder picks at least one skill", () =>
    expect(
      skillSourceAddBodySchema.safeParse({ kind: "folder", path: "/code/skills", skills: [] })
        .success,
    ).toBe(false));

  test("an add refuses a skill name that isn't a folder name", () => {
    const bad = skillSourceAddBodySchema.safeParse({
      kind: "folder",
      path: "/code/skills",
      skills: ["../evil"],
    });
    expect(bad.error?.issues[0]?.message).toBe("Not a valid skill folder name.");
  });

  test("an empty folder path says where a path starts", () => {
    const bad = skillSourcePreviewBodySchema.safeParse({ kind: "folder", path: "" });
    expect(bad.error?.issues.map((i) => i.message)).toEqual([MSG.hostPathStart]);
  });

  test("an oversized SKILL.md says so", () => {
    const bad = skillDetailSchema.safeParse({
      group: "host",
      name: "review",
      description: "",
      state: "ok",
      usedBy: { templates: 0, agents: 0 },
      hooks: [],
      usedByTemplates: [],
      files: [],
      skillMd: "x".repeat(256 * 1024 + 1),
      skillMdCut: true,
    });
    expect(bad.error?.issues[0]?.message).toBe(MSG.skillMdSize);
  });

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
      skillMdCut: false,
    };
    expect(
      skillDetailSchema.safeParse({ ...detail, skillMd: "x".repeat(256 * 1024 + 1) }).success,
    ).toBe(false);
  });
});

describe("source responses", () => {
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
