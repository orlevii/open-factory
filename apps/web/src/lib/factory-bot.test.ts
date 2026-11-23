import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_HUES, avatarL, oklchDistance } from "@open-factory/shared";
import { expect, test } from "vitest";
import { SRC } from "../test/ui-contract-files";
import { botParts, contrast, fnv1a32, oklchToRelLuminance } from "./factory-bot";

test("fnv1a32 known vectors", () => {
  expect(fnv1a32("")).toBe(0x811c9dc5);
  expect(fnv1a32("a")).toBe(0xe40c292c);
});

test("botParts golden vectors (a change here must be deliberate)", () => {
  const slugs = [
    "lead",
    "dev",
    "reviewer",
    "dev-abcd",
    "a".repeat(40),
    "ceo",
    "qa",
    "pm",
    "designer",
    "ops-xyzw",
  ];
  expect(Object.fromEntries(slugs.map((s) => [s, botParts(s)]))).toMatchInlineSnapshot(`
    {
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
        "accessory": 3,
        "eyes": 3,
        "fill": 12,
        "head": 1,
        "mouth": 0,
      },
      "ceo": {
        "accessory": 1,
        "eyes": 3,
        "fill": 4,
        "head": 2,
        "mouth": 0,
      },
      "designer": {
        "accessory": 1,
        "eyes": 1,
        "fill": 4,
        "head": 0,
        "mouth": 0,
      },
      "dev": {
        "accessory": 4,
        "eyes": 5,
        "fill": 10,
        "head": 0,
        "mouth": 3,
      },
      "dev-abcd": {
        "accessory": 0,
        "eyes": 4,
        "fill": 8,
        "head": 3,
        "mouth": 3,
      },
      "lead": {
        "accessory": 2,
        "eyes": 3,
        "fill": 10,
        "head": 3,
        "mouth": 0,
      },
      "ops-xyzw": {
        "accessory": 2,
        "eyes": 5,
        "fill": 8,
        "head": 2,
        "mouth": 3,
      },
      "pm": {
        "accessory": 0,
        "eyes": 1,
        "fill": 12,
        "head": 2,
        "mouth": 0,
      },
      "qa": {
        "accessory": 2,
        "eyes": 3,
        "fill": 8,
        "head": 3,
        "mouth": 1,
      },
      "reviewer": {
        "accessory": 4,
        "eyes": 2,
        "fill": 2,
        "head": 2,
        "mouth": 2,
      },
    }
  `);
});

test("parts stay in range", () => {
  for (const s of ["x", "lead", "z9"]) {
    const p = botParts(s);
    expect(p.fill).toBeGreaterThanOrEqual(1);
    expect(p.fill).toBeLessThanOrEqual(12);
  }
});

test("avatar ink reaches 3:1 on every fill in both themes (computed from styles.css)", () => {
  const css = readFileSync(join(SRC, "styles.css"), "utf8");
  const fills = [...css.matchAll(/--avatar-(\d+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)];
  expect(fills.length).toBe(24);
  const ink = oklchToRelLuminance(0.2, 0.008, 255);
  for (const [, , l, c, h] of fills) {
    expect(
      contrast(oklchToRelLuminance(Number(l), Number(c), Number(h)), ink),
    ).toBeGreaterThanOrEqual(3);
  }
});

test("avatar-ink is declared in both themes", () => {
  const css = readFileSync(join(SRC, "styles.css"), "utf8");
  expect(css.match(/--avatar-ink:\s*oklch\(0\.2 0\.008 255\)/g)?.length).toBe(2);
  expect(css).toContain("--color-avatar-ink: var(--avatar-ink)");
});

test("styles.css tokens equal AVATAR_HUES and clear the dE gate per theme", () => {
  const css = readFileSync(join(SRC, "styles.css"), "utf8");
  const all = [...css.matchAll(/--avatar-(\d+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)].map(
    (m) => ({ index: Number(m[1]), l: Number(m[2]), c: Number(m[3]), h: Number(m[4]) }),
  );
  expect(all.length).toBe(24);
  for (const [t, theme] of (["light", "dark"] as const).entries()) {
    const block = all.slice(t * 12, t * 12 + 12);
    expect(block).toEqual(
      AVATAR_HUES.map((e) => ({
        index: e.index,
        l: avatarL(theme, e.tier),
        c: 0.07,
        h: e.hue,
      })),
    );
    let min = Number.POSITIVE_INFINITY;
    for (const [i, a] of block.entries())
      for (const b of block.slice(i + 1)) min = Math.min(min, oklchDistance(a, b));
    expect(min).toBeGreaterThanOrEqual(0.03);
  }
  for (let i = 1; i <= 12; i++) expect(css).toContain(`--color-avatar-${i}: var(--avatar-${i});`);
});

test("only fill changed against the 8-colour seeding (same face parts)", () => {
  // Face parts are drawn before fill, so these goldens predate the 12-colour change.
  expect(botParts("lead")).toMatchObject({ head: 3, eyes: 3, mouth: 0, accessory: 2 });
  expect(botParts("dev")).toMatchObject({ head: 0, eyes: 5, mouth: 3, accessory: 4 });
});
