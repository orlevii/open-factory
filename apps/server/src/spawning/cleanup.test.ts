import type { ProjectResult } from "@open-factory/shared";
import { describe, expect, it } from "vitest";
import { noticeBody } from "./cleanup";

const res = (r: Partial<ProjectResult> & { project: string }): ProjectResult => ({
  removed: false,
  deleted: [],
  kept: [],
  ...r,
});

describe("noticeBody", () => {
  it("says what was cleaned up and what was kept, per project", () => {
    expect(
      noticeBody("dev-ab12", [
        res({
          project: "web",
          removed: true,
          kept: [
            { branch: "feat/x", commits: 3 },
            { branch: "feat/y", reason: "elsewhere" },
          ],
        }),
      ]),
    ).toBe(
      [
        "Cleaned up @dev-ab12's worktrees.",
        "web: kept `feat/x` (3 commits not pushed or merged), `feat/y` (checked out elsewhere)",
      ].join("\n"),
    );
  });

  it("uses the singular for one commit", () => {
    expect(
      noticeBody("dev-ab12", [
        res({ project: "web", removed: true, kept: [{ branch: "a", commits: 1 }] }),
      ]),
    ).toContain("`a` (1 commit not pushed or merged)");
  });

  it("returns null when everything was removed and nothing is left to say", () => {
    expect(
      noticeBody("dev-ab12", [res({ project: "web", removed: true, deleted: ["feat/y"] })]),
    ).toBeNull();
    expect(noticeBody("dev-ab12", [])).toBeNull();
  });

  it("prints a project's error as it is, without repeating the prefix, and says it couldn't fully clean up", () => {
    expect(
      noticeBody("dev-ab12", [
        res({ project: "web", removed: true, kept: [{ branch: "a", commits: 2 }] }),
        res({ project: "docs", error: "couldn't clean up: not a git repository" }),
      ]),
    ).toBe(
      [
        "Couldn't fully clean up @dev-ab12's worktrees.",
        "web: kept `a` (2 commits not pushed or merged)",
        "docs: couldn't clean up: not a git repository",
      ].join("\n"),
    );
  });

  it("says it couldn't fully clean up when nothing was removed", () => {
    expect(
      noticeBody("dev-ab12", [
        res({ project: "web", kept: [{ branch: "a", reason: "elsewhere" }] }),
      ]),
    ).toMatch(/^Couldn't fully clean up @dev-ab12's worktrees\./);
  });

  it("puts a kept branch and an error of the same project on one line", () => {
    expect(
      noticeBody("dev-ab12", [
        res({
          project: "web",
          removed: true,
          kept: [{ branch: "a", commits: 2 }],
          error: "couldn't check `b`; left in place",
        }),
      ]),
    ).toContain(
      "web: kept `a` (2 commits not pushed or merged); couldn't check `b`; left in place",
    );
  });

  it.each([
    ["missing", "Couldn't clean up worktrees: git isn't installed on the factory host."],
    ["too_old", "Couldn't clean up worktrees: git 2.44 or newer is needed on the factory host."],
  ] as const)("adds the host line for git %s", (kind, line) => {
    expect(noticeBody("dev-ab12", [], kind)).toBe(
      ["Couldn't fully clean up @dev-ab12's worktrees.", line].join("\n"),
    );
  });

  it("keeps results found before the host line", () => {
    const body = noticeBody(
      "dev-ab12",
      [res({ project: "web", removed: true, kept: [{ branch: "a", commits: 2 }] })],
      "missing",
    );
    expect(body).toContain("web: kept `a`");
    expect(body).toContain("git isn't installed on the factory host.");
  });

  it("lists at most 20 entries, then how many more are in the session", () => {
    const kept = Array.from({ length: 25 }, (_, i) => ({ branch: `b${i}`, commits: 2 }));
    const body = noticeBody("dev-ab12", [res({ project: "web", removed: true, kept })]) ?? "";
    expect(body).toContain("`b19`");
    expect(body).not.toContain("`b20`");
    expect(body.split("\n").at(-1)).toBe("and 5 more in @dev-ab12's session");
  });

  it("counts failures as entries and spans projects in the cap", () => {
    const results = [
      res({
        project: "a",
        removed: true,
        kept: Array.from({ length: 19 }, (_, i) => ({ branch: `x${i}`, commits: 2 })),
      }),
      res({ project: "b", error: "couldn't clean up: not a git repository" }),
      res({ project: "c", error: "couldn't clean up: not a git repository" }),
    ];
    const body = noticeBody("dev-ab12", results) ?? "";
    expect(body).toContain("b: couldn't clean up");
    expect(body).not.toContain("c: couldn't clean up");
    expect(body.split("\n").at(-1)).toBe("and 1 more in @dev-ab12's session");
  });
});
