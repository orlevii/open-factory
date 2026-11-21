export type BotParts = {
  head: 0 | 1 | 2 | 3;
  eyes: 0 | 1 | 2 | 3 | 4 | 5;
  mouth: 0 | 1 | 2 | 3;
  accessory: 0 | 1 | 2 | 3 | 4;
  fill: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
};

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic parts for a slug: peel one field at a time off the hash. */
export function botParts(slug: string): BotParts {
  let h = fnv1a32(slug);
  const take = (count: number): number => {
    const v = h % count;
    h = Math.floor(h / count);
    return v;
  };
  const head = take(4) as BotParts["head"];
  const eyes = take(6) as BotParts["eyes"];
  const mouth = take(4) as BotParts["mouth"];
  const accessory = take(5) as BotParts["accessory"];
  const fill = (take(8) + 1) as BotParts["fill"];
  return { head, eyes, mouth, accessory, fill };
}

/** WCAG relative luminance of an OKLCH colour (h in degrees), via OKLab to linear sRGB. */
export function oklchToRelLuminance(l: number, c: number, h: number): number {
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

export function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
