import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { classifyPluginSource, readPluginSource } from "./plugin-sources.ts";
import { makeFixtureRepo } from "./testing/fixture-repo.ts";

const SHA = "a".repeat(40);

describe("classifyPluginSource", () => {
  test.each([
    ["a relative path", { source: "./plugins/x" }, { kind: "relative", path: "plugins/x" }],
    [
      "a github source with a sha",
      { source: { source: "github", repo: "acme/x", sha: SHA } },
      { kind: "external", pinnable: true },
    ],
    [
      "a url source with a sha",
      { source: { source: "url", url: "https://example.com/x.git", sha: SHA } },
      { kind: "external", pinnable: true },
    ],
    [
      "a git-subdir source with a sha",
      { source: { source: "git-subdir", url: "acme/x", path: "sub", sha: SHA } },
      { kind: "external", pinnable: true },
    ],
    [
      "an archive with a sha256",
      { source: { source: "archive", url: "https://example.com/x.zip", sha256: "b".repeat(64) } },
      { kind: "external", pinnable: true },
    ],
    [
      "a github source without a sha follows its source",
      { source: { source: "github", repo: "acme/x" } },
      { kind: "external", pinnable: false },
    ],
    [
      "a url source without a sha follows its source",
      { source: { source: "url", url: "https://example.com/x.git" } },
      { kind: "external", pinnable: false },
    ],
    [
      "a sha that isn't hex follows its source",
      { source: { source: "github", repo: "acme/x", sha: "main" } },
      { kind: "external", pinnable: false },
    ],
  ])("%s", (_, entry, expected) => {
    expect(classifyPluginSource(entry)).toMatchObject(expected);
  });

  test.each([
    ["npm", { source: { source: "npm", package: "x" } }, "npm"],
    ["command", { source: { source: "command", command: "x" } }, "command"],
    [
      "headersHelper",
      { source: { source: "github", repo: "acme/x", sha: SHA, headersHelper: "x" } },
      "headersHelper",
    ],
    [
      "an archive without sha256",
      { source: { source: "archive", url: "https://example.com/x.zip" } },
      "archive",
    ],
    ["a relative path that leaves the repo", { source: "./../x" }, "path"],
    [
      "a url with userinfo",
      { source: { source: "url", url: "https://u:p@example.com/x.git", sha: SHA } },
      "url",
    ],
    [
      "a url with a fragment",
      { source: { source: "url", url: "https://example.com/x.git#main", sha: SHA } },
      "url",
    ],
    [
      "a url with a query",
      { source: { source: "url", url: "https://example.com/x.git?a=1", sha: SHA } },
      "url",
    ],
    [
      "an option as the url",
      { source: { source: "url", url: "--upload-pack=x", sha: SHA } },
      "url",
    ],
    [
      "an option as the path",
      { source: { source: "git-subdir", url: "acme/x", path: "-x", sha: SHA } },
      "git-subdir",
    ],
    ["no source", {}, "unknown"],
  ])("refuses %s", (_, entry, label) => {
    expect(classifyPluginSource(entry)).toEqual({ kind: "refused", label });
  });
});

describe("readPluginSource", () => {
  let tmp: string;
  let fh: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "of-psrc-")));
    fh = path.join(tmp, "fh");
    mkdirSync(fh);
  });
  afterEach(async () => {
    const fix = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          chmodSync(path.join(d, e.name), 0o755);
          fix(path.join(d, e.name));
        }
      }
    };
    fix(tmp);
    await rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ factoryHome: fh, githubUrl: `file://${tmp}/gh` });

  test("fetches a git-subdir source at its sha, read-only, and reuses it", async () => {
    const { shas } = await makeFixtureRepo(path.join(tmp, "gh", "acme", "ext.git"), {
      commits: [{ "sub/a.txt": "one", "other/b.txt": "x" }, { "sub/a.txt": "two" }],
    });
    const src = { source: "git-subdir", url: "acme/ext", path: "sub", sha: shas[0] } as const;
    const dir = await readPluginSource(src, shas[0] as string, opts());
    expect(path.relative(path.join(fh, "state", "library", "plugin-sources"), dir)).toMatch(
      new RegExp(`^[0-9a-f]{32}/${shas[0]}$`),
    );
    expect(execFileSync("cat", [path.join(dir, "a.txt")], { encoding: "utf8" })).toBe("one");
    expect(statSync(dir).mode & 0o222).toBe(0);
    expect(statSync(path.join(dir, "a.txt")).mode & 0o222).toBe(0);
    expect(readdirSync(dir)).toEqual(["a.txt"]);
    // A second read is the same directory, and the other commit is its own.
    expect(await readPluginSource(src, shas[0] as string, opts())).toBe(dir);
    const second = await readPluginSource({ ...src, sha: shas[1] }, shas[1] as string, opts());
    expect(second).not.toBe(dir);
    expect(execFileSync("cat", [path.join(second, "a.txt")], { encoding: "utf8" })).toBe("two");
  });

  test("a github source reads the repo root", async () => {
    const { shas } = await makeFixtureRepo(path.join(tmp, "gh", "acme", "ext.git"), {
      commits: [{ "a.txt": "root" }],
    });
    const dir = await readPluginSource(
      { source: "github", repo: "acme/ext", sha: shas[0] },
      shas[0] as string,
      opts(),
    );
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test.each([
    ["userinfo", "https://user:tok@example.com/x.git"],
    ["a query", "https://example.com/x.git?a=1"],
    ["a fragment", "https://example.com/x.git#main"],
    ["a leading dash", "--upload-pack=touch /tmp/pwned"],
    ["a dash-leading shorthand", "-x/y"],
    ["a non-https scheme", "ssh://git@example.com/x.git"],
  ])("refuses %s in the url", async (_, url) => {
    await expect(readPluginSource({ source: "url", url, sha: SHA }, SHA, opts())).rejects.toThrow();
    expect(existsSync(path.join(fh, "state", "library", "plugin-sources"))).toBe(false);
  });

  test("refuses a path that starts with a dash and a sha that isn't one", async () => {
    await expect(
      readPluginSource({ source: "git-subdir", url: "acme/x", path: "-x", sha: SHA }, SHA, opts()),
    ).rejects.toThrow();
    await expect(
      readPluginSource({ source: "github", repo: "acme/x" }, "main", opts()),
    ).rejects.toThrow();
  });

  test("fails closed when the repo doesn't hold the sha", async () => {
    await makeFixtureRepo(path.join(tmp, "gh", "acme", "ext.git"), { commits: [{ "a.txt": "x" }] });
    await expect(
      readPluginSource({ source: "github", repo: "acme/ext", sha: SHA }, SHA, opts()),
    ).rejects.toThrow();
  });
});
