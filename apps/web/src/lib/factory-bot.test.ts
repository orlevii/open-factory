import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_CHROMA, AVATAR_HUES, avatarL, oklchDistance } from "@open-factory/shared";
import { expect, test } from "vitest";
import { SRC } from "../test/ui-contract-files";
import { botParts, fnv1a32 } from "./factory-bot";

/** WCAG relative luminance of an OKLCH colour (h in degrees), via OKLab to linear sRGB. */
function oklchToRelLuminance(l: number, c: number, h: number): number {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  // Clamp to gamut, then use linear values directly (luminance is linear-light).
  const lin = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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

test("every part stays an integer in its range, over many slugs", () => {
  const ranges = { head: [0, 3], eyes: [0, 5], mouth: [0, 3], accessory: [0, 4], fill: [1, 12] };
  for (let i = 0; i < 500; i++) {
    const p = botParts(`agent-${i}-${(i * 7919).toString(36)}`);
    for (const [part, [lo, hi]] of Object.entries(ranges) as [keyof typeof ranges, number[]][]) {
      const v = p[part];
      expect(Number.isInteger(v), `${part} of #${i}`).toBe(true);
      expect(v, `${part} of #${i}`).toBeGreaterThanOrEqual(lo as number);
      expect(v, `${part} of #${i}`).toBeLessThanOrEqual(hi as number);
    }
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
        c: AVATAR_CHROMA,
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
