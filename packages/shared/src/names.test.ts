import { expect, test } from "vitest";
import {
  isReservedSecretName,
  nameSchema,
  RESERVED_SLUGS,
  secretNameSchema,
  slugSchema,
} from "./names.ts";

test("slug rules", () => {
  for (const ok of ["abc", "team-lead", "a1-b2"])
    expect(slugSchema.safeParse(ok).success).toBe(true);
  for (const bad of [
    "a",
    "-ab",
    "ab-",
    "Ab",
    "a_b",
    "a".repeat(41),
    "humans",
    "me",
    "scheduler",
    "all",
    "system",
    "factory",
  ])
    expect(slugSchema.safeParse(bad).success).toBe(false);
  expect(RESERVED_SLUGS).toEqual(["humans", "me", "scheduler", "factory", "all", "system"]);
});

test("names and secret names", () => {
  expect(nameSchema.safeParse("app").success).toBe(true);
  expect(nameSchema.safeParse("x").success).toBe(false);
  expect(secretNameSchema.safeParse("GH_TOKEN").success).toBe(true);
  for (const bad of [
    "gh_token",
    "1A",
    "PATH",
    "HOME",
    "LC_ALL",
    "LD_PRELOAD",
    "DYLD_X",
    "CLAUDE_X",
    "ANTHROPIC_API_KEY",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_EMAIL",
    "NODE_OPTIONS",
  ])
    expect(secretNameSchema.safeParse(bad).success).toBe(false);
  expect(isReservedSecretName("TMPDIR")).toBe(true);
  expect(isReservedSecretName("OPEN_FACTORY_AGENT_TOKEN")).toBe(true);
  expect(isReservedSecretName("GH_TOKEN")).toBe(false);
});
