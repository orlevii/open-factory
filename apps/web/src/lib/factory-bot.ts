export type BotParts = {
  head: 0 | 1 | 2 | 3;
  eyes: 0 | 1 | 2 | 3 | 4 | 5;
  mouth: 0 | 1 | 2 | 3;
  accessory: 0 | 1 | 2 | 3 | 4;
  fill: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
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
  const fill = (take(12) + 1) as BotParts["fill"];
  return { head, eyes, mouth, accessory, fill };
}
