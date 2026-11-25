import { mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ApiError } from "../errors.ts";
import { checkErrorText, touchDir } from "./common.ts";
import { GitError } from "./git.ts";

test("a failed check keeps a git or validation message, redacted, for skill sources and marketplaces alike", () => {
  const token = `ghp_${"a".repeat(36)}`;
  expect(
    checkErrorText(
      new GitError(`fatal: could not read https://x:${token}@github.com/a/b`, ""),
      "fb",
    ),
  ).not.toContain(token);
  expect(checkErrorText(new ApiError(400, "validation_error", "Bad folder"), "fb")).toBe(
    "Bad folder",
  );
  expect(checkErrorText(new Error("ENOENT /secret/path"), "Couldn't check")).toBe("Couldn't check");
});

test("touching a staged copy makes it look fresh to the preview purge", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "of-touch-"));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(dir, old, old);
  await touchDir(dir);
  expect(Date.now() - (await stat(dir)).mtimeMs).toBeLessThan(60_000);
});
