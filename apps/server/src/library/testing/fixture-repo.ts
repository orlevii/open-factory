/**
 * Builds a local git repo for tests and evidence passes, served over `file://`. Needs real `git`
 * on the host; the library code under test still goes through the hardened `runGit`.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type FixtureEntry = string | { symlink: string } | { gitlink: true } | { bytes: number };

export interface FixtureSpec {
  /** Each commit is the whole tree at that point: path to content. */
  commits: Array<Record<string, FixtureEntry>>;
  /** Extra branches by name, pointing at the commit with that index. */
  branches?: Record<string, number>;
  /** The branch HEAD points at (default `main`), which tracks the last commit. */
  defaultBranch?: string;
}

const GITLINK_SHA = "1111111111111111111111111111111111111111";

async function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      },
    },
  );
  return stdout.trim();
}

export async function makeFixtureRepo(
  dir: string,
  spec: FixtureSpec,
): Promise<{ url: string; shas: string[] }> {
  await mkdir(dir, { recursive: true });
  const main = spec.defaultBranch ?? "main";
  await git(dir, ["init", "-q", "-b", main]);
  await git(dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const shas: string[] = [];
  for (const [i, files] of spec.commits.entries()) {
    for (const name of await readdir(dir)) {
      if (name !== ".git") await rm(path.join(dir, name), { recursive: true, force: true });
    }
    const gitlinks: string[] = [];
    for (const [rel, entry] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      if (typeof entry === "string") await writeFile(abs, entry);
      else if ("symlink" in entry) await symlink(entry.symlink, abs);
      else if ("bytes" in entry) await writeFile(abs, Buffer.alloc(entry.bytes, 97));
      else gitlinks.push(rel);
    }
    await git(dir, ["add", "-A"]);
    for (const rel of gitlinks) {
      await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${GITLINK_SHA},${rel}`]);
    }
    const date = `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`;
    await git(dir, ["commit", "-q", "--allow-empty", "-m", `commit ${i + 1}`], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    shas.push(await git(dir, ["rev-parse", "HEAD"]));
  }
  for (const [name, index] of Object.entries(spec.branches ?? {})) {
    await git(dir, ["branch", name, shas[index] as string]);
  }
  return { url: `file://${dir}`, shas };
}
