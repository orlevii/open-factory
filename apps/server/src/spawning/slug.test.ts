import { expect, test } from "vitest";
import { spawnSlug } from "./slug.ts";

const r = () => "abcd";
test.each([
  ["tech-lead", undefined, { ok: true, slug: "tech-lead-abcd", explicit: false }],
  ["tech-lead", "issue17", { ok: true, slug: "tech-lead-issue17", explicit: true }],
  ["tech-lead", "x-", { ok: false, message: "A suffix can't end with a hyphen." }],
  [
    "tech-lead",
    "a".repeat(40),
    {
      ok: false,
      message: `tech-lead-${"a".repeat(40)} is longer than 40 characters; use a shorter suffix.`,
    },
  ],
  [
    "t".repeat(36),
    undefined,
    {
      ok: false,
      message: `Template ${"t".repeat(36)}'s name is too long for a 4-character suffix; pass a shorter suffix.`,
    },
  ],
  [
    "t".repeat(39),
    undefined,
    { ok: false, message: `Template ${"t".repeat(39)}'s name is too long to spawn from.` },
  ],
])("%s + %s", (template, suffix, want) => {
  expect(spawnSlug(template, suffix, r)).toEqual(want);
});
