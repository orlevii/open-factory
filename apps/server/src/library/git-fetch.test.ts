import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GitError } from "./git.ts";
import {
  checkoutSize,
  fetchCommit,
  installCheckout,
  joinRepoPath,
  repoUrl,
  resolveRef,
  treeShas,
} from "./git-fetch.ts";
import { makeFixtureRepo } from "./testing/fixture-repo.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "of-fetch-"));
});
afterEach(async () => {
  // installCheckout leaves read-only trees behind.
  const fix = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        chmodSync(p, 0o755);
        fix(p);
      }
    }
  };
  fix(tmp);
  await rm(tmp, { recursive: true, force: true });
});

const o = { allowFile: true };

test("repoUrl joins base, owner and repo", () => {
  expect(repoUrl("https://github.com", { owner: "acme", repo: "x" })).toBe(
    "https://github.com/acme/x.git",
  );
});

test("resolveRef takes the exact branch line, never a decoy that tail-matches", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ a: "1" }, { a: "2" }],
    branches: { "x/refs/heads/main": 0 },
  });
  expect(await resolveRef(f.url, "main", o)).toEqual({ sha: f.shas[1], branch: "main" });
});

test("resolveRef refuses when only a decoy matches", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ a: "1" }],
    defaultBranch: "dev",
    branches: { "x/refs/heads/main": 0 },
  });
  await expect(resolveRef(f.url, "main", { ...o, label: "acme/x" })).rejects.toThrow(
    "No branch main in acme/x.",
  );
});

test("resolveRef returns the default branch's name for null", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ a: "1" }],
    defaultBranch: "dev",
  });
  expect(await resolveRef(f.url, null, o)).toEqual({ sha: f.shas[0], branch: "dev" });
});

test("fetchCommit returns date and subject and checks out the commit", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ "s/SKILL.md": "one" }, { "s/SKILL.md": "two" }],
  });
  const co = path.join(tmp, "co");
  const r = await fetchCommit(f.url, f.shas[0] as string, co, o);
  expect(r).toEqual({ committedAt: "2026-01-01T00:00:00Z", subject: "commit 1" });
  expect(readFileSync(path.join(co, "s/SKILL.md"), "utf8")).toBe("one");
});

test("fetchCommit fails closed when git returns another commit", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), { commits: [{ a: "1" }] });
  const bin = path.join(tmp, "fakegit");
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = rev-parse ]; then echo ${"b".repeat(40)}; exit 0; fi; done\nexec git "$@"\n`,
  );
  chmodSync(bin, 0o755);
  await expect(
    fetchCommit(f.url, f.shas[0] as string, path.join(tmp, "co"), {
      ...o,
      gitBin: bin,
      label: "acme/x",
    }),
  ).rejects.toThrow(`acme/x didn't return commit ${(f.shas[0] as string).slice(0, 7)}.`);
});

test("fetchCommit and resolveRef stop at the operation budget", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), { commits: [{ a: "1" }] });
  const bin = path.join(tmp, "slowgit");
  writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
  chmodSync(bin, 0o755);
  const slow = { ...o, gitBin: bin, budgetMs: 200 };
  const t0 = Date.now();
  await expect(resolveRef(f.url, "main", slow)).rejects.toThrow(/timed out/);
  await expect(fetchCommit(f.url, f.shas[0] as string, path.join(tmp, "co"), slow)).rejects.toThrow(
    GitError,
  );
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("a symlink arrives as a regular file and a gitlink as an empty dir", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ real: "x", link: { symlink: "real" }, sub: { gitlink: true } }],
  });
  const co = path.join(tmp, "co");
  await fetchCommit(f.url, f.shas[0] as string, co, o);
  expect(lstatSync(path.join(co, "link")).isFile()).toBe(true);
  expect(lstatSync(path.join(co, "sub")).isDirectory()).toBe(true);
  expect(readdirSync(path.join(co, "sub"))).toEqual([]);
});

test("checkoutSize counts the working tree and throws over_cap past the cap", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ big: { bytes: 51 * 1024 * 1024 }, small: "abc" }],
  });
  const co = path.join(tmp, "co");
  await fetchCommit(f.url, f.shas[0] as string, co, o);
  await expect(checkoutSize(co, 50 * 1024 * 1024)).rejects.toThrow("over_cap");
  expect(await checkoutSize(co, 100 * 1024 * 1024)).toBe(51 * 1024 * 1024 + 3);
});

test("installCheckout copies the subtree read-only without .git", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ "skills/a/SKILL.md": "hi", "skills/a/run.sh": "#!/bin/sh\n", other: "no" }],
  });
  const co = path.join(tmp, "co");
  await fetchCommit(f.url, f.shas[0] as string, co, o);
  chmodSync(path.join(co, "skills/a/run.sh"), 0o755);
  const dest = path.join(tmp, "cache/src1/sha");
  await installCheckout(co, "skills", dest);
  expect(readdirSync(dest)).toEqual(["a"]);
  expect(existsSync(path.join(dest, ".git"))).toBe(false);
  expect(statSync(dest).mode & 0o777).toBe(0o555);
  expect(statSync(path.join(dest, "a")).mode & 0o777).toBe(0o555);
  expect(statSync(path.join(dest, "a/SKILL.md")).mode & 0o777).toBe(0o444);
  expect(statSync(path.join(dest, "a/run.sh")).mode & 0o777).toBe(0o555);
  expect(readFileSync(path.join(dest, "a/SKILL.md"), "utf8")).toBe("hi");
  chmodSync(dest, 0o755);
});

test("installCheckout refuses a subpath that escapes, lexically or by realpath", async () => {
  const co = path.join(tmp, "co");
  mkdirSync(co);
  mkdirSync(path.join(tmp, "outside"));
  writeFileSync(path.join(tmp, "outside/secret"), "s");
  await import("node:fs").then((fs) =>
    fs.symlinkSync(path.join(tmp, "outside"), path.join(co, "esc")),
  );
  for (const sub of ["../outside", "a/../../outside", "/etc", "esc"]) {
    await expect(installCheckout(co, sub, path.join(tmp, "dest"))).rejects.toThrow(/inside/);
  }
  expect(existsSync(path.join(tmp, "dest"))).toBe(false);
});

test("treeShas joins an empty subpath without a leading slash", async () => {
  const f = await makeFixtureRepo(path.join(tmp, "r"), {
    commits: [{ "skill/SKILL.md": "x", "pre/skill/SKILL.md": "y" }],
  });
  const co = path.join(tmp, "co");
  await fetchCommit(f.url, f.shas[0] as string, co, o);
  expect(joinRepoPath("", "skill")).toBe("skill");
  expect(joinRepoPath("pre", "skill")).toBe("pre/skill");
  const shas = await treeShas(co, f.shas[0] as string, [
    joinRepoPath("", "skill"),
    joinRepoPath("pre", "skill"),
  ]);
  expect(Object.keys(shas)).toEqual(["skill", "pre/skill"]);
  expect(shas.skill).toMatch(/^[0-9a-f]{40}$/);
  expect(shas.skill).not.toBe(shas["pre/skill"]);
});
