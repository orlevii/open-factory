/** Highlights already made, by (language, code), so a re-mounted or persisted block paints highlighted
 *  on its first frame and `highlight()` runs once per fence (U3 §11.4). An LRU of 200 entries. It
 *  imports nothing from shiki: the highlighter stays behind `highlight.ts`'s dynamic import. */
const MAX_ENTRIES = 200;
const entries = new Map<string, string>();
const keyOf = (lang: string, code: string) => `${lang}\u0000${code}`;

export const highlightCache = {
  get(lang: string, code: string): string | undefined {
    const key = keyOf(lang, code);
    const html = entries.get(key);
    if (html !== undefined) {
      // Most recently used goes last.
      entries.delete(key);
      entries.set(key, html);
    }
    return html;
  },
  set(lang: string, code: string, html: string): void {
    const key = keyOf(lang, code);
    entries.delete(key);
    entries.set(key, html);
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  },
  /** Tests only. */
  clear(): void {
    entries.clear();
  },
};
