/** Highlights already made, by (language, code), so a re-mounted or persisted block paints highlighted
 *  on its first frame and `highlight()` runs once per fence (U3 §11.4). An LRU of at most 200 entries
 *  within a 4 MB budget; code over 16 KB isn't kept (a fence that large highlights again on a
 *  re-mount). It imports nothing from shiki: the highlighter stays behind `highlight.ts`'s dynamic
 *  import. */
const MAX_ENTRIES = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CODE = 16 * 1024;
const entries = new Map<string, string>();
let bytes = 0;
const keyOf = (lang: string, code: string) => `${lang}\u0000${code}`;
/** UTF-16: two bytes per code unit, the key (which holds the code) and the HTML. */
const sizeOf = (key: string, html: string) => 2 * (key.length + html.length);

export const highlightCache = {
  /** Called during render. A hit is moved to the most recent end by re-inserting it: a mutation of
   *  module state during render, harmless because it changes only the eviction order. */
  get(lang: string, code: string): string | undefined {
    const key = keyOf(lang, code);
    const html = entries.get(key);
    if (html !== undefined) {
      entries.delete(key);
      entries.set(key, html);
    }
    return html;
  },
  set(lang: string, code: string, html: string): void {
    if (code.length > MAX_CODE) return;
    const key = keyOf(lang, code);
    const old = entries.get(key);
    if (old !== undefined) {
      entries.delete(key);
      bytes -= sizeOf(key, old);
    }
    entries.set(key, html);
    bytes += sizeOf(key, html);
    while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= sizeOf(oldest, entries.get(oldest) as string);
      entries.delete(oldest);
    }
  },
  /** Tests only: the bytes held. */
  bytes(): number {
    return bytes;
  },
  /** Tests only. */
  clear(): void {
    entries.clear();
    bytes = 0;
  },
};
