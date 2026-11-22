import { describe, expect, test } from "vitest";
import { deriveSlug, foldLetters } from "./derive-slug";

const none = new Set<string>();

describe("deriveSlug", () => {
  test.each([
    ["Priya Nair", "priya-nair"],
    ["Łukasz Żak", "lukasz-zak"],
    ["Søren Lund", "soren-lund"],
    ["Straße", "strasse"],
    ["Æther Œuvre", "aether-oeuvre"],
    ["Đorđe", "dorde"],
    ["Iğdır ı", "igdir-i"],
    ["Þór", "thor"],
    ["  --Ops!!  Lead-- ", "ops-lead"],
    ["陳大文", ""],
    ["🤖", ""],
    ["9lives", ""],
  ])("%s → %s", (n, s) => expect(deriveSlug(n, none)).toBe(s));

  test("taken names get -2, -3", () => {
    expect(deriveSlug("Priya Nair", new Set(["priya-nair"]))).toBe("priya-nair-2");
    expect(deriveSlug("Priya Nair", new Set(["priya-nair", "priya-nair-2"]))).toBe("priya-nair-3");
  });

  test("a 40-char base is cut so the suffix fits, never '--2'", () => {
    const name = "abcdefghij abcdefghij abcdefghij abcdefgh";
    const base = deriveSlug(name, none);
    expect(base.length).toBe(40);
    const s = deriveSlug(name, new Set([base]));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).not.toMatch(/--/);
    expect(s.endsWith("-2")).toBe(true);
  });

  test("reserved and human handles count as taken", () => {
    expect(deriveSlug("Me", new Set(["me"]))).toBe("me-2");
  });
});

test("foldLetters folds what NFKD leaves alone", () => {
  expect(foldLetters("Łø ß")).toBe("Lo ss");
});
