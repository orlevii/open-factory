import { expect, test } from "vitest";
import { AVATAR_COUNT, AVATAR_HUES, avatarL, oklchDistance } from "./avatar.ts";

const THEMES = ["light", "dark"] as const;
const fills = (theme: (typeof THEMES)[number]) =>
  AVATAR_HUES.map((e) => ({ l: avatarL(theme, e.tier), c: 0.07, h: e.hue }));

test("twelve entries in the spec order, odd deep and even light", () => {
  expect(AVATAR_COUNT).toBe(12);
  expect(AVATAR_HUES.map((e) => e.hue)).toEqual([
    115, 130, 175, 190, 205, 220, 270, 285, 300, 315, 330, 345,
  ]);
  for (const [i, e] of AVATAR_HUES.entries()) {
    expect(e.index).toBe(i + 1);
    expect(e.tier).toBe(e.index % 2 === 1 ? "deep" : "light");
    expect(e.name.length).toBeGreaterThan(0);
  }
});

test("tier lightness", () => {
  expect([avatarL("light", "deep"), avatarL("light", "light")]).toEqual([0.56, 0.68]);
  expect([avatarL("dark", "deep"), avatarL("dark", "light")]).toEqual([0.64, 0.76]);
});

test("hues keep 15 degrees from success (150) and info (250) and out of 0-100", () => {
  for (const { hue } of AVATAR_HUES) {
    expect(Math.abs(hue - 150)).toBeGreaterThanOrEqual(15);
    expect(Math.abs(hue - 250)).toBeGreaterThanOrEqual(15);
    expect(hue).toBeGreaterThan(100);
  }
});

test("minimum pairwise dE_ok over all 12 fills is at least 0.030 per theme", () => {
  for (const theme of THEMES) {
    const f = fills(theme);
    let min = Number.POSITIVE_INFINITY;
    for (const [i, a] of f.entries())
      for (const b of f.slice(i + 1)) min = Math.min(min, oklchDistance(a, b));
    expect(min).toBeGreaterThanOrEqual(0.03);
  }
});

test("oklchDistance is symmetric and zero on identity", () => {
  const a = { l: 0.5, c: 0.07, h: 100 };
  const b = { l: 0.6, c: 0.07, h: 200 };
  expect(oklchDistance(a, a)).toBe(0);
  expect(oklchDistance(a, b)).toBeCloseTo(oklchDistance(b, a), 12);
});
