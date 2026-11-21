type Listener = (e: MediaQueryListEvent) => void;
/** A window.matchMedia whose lists all share one `matches` flag (per query family: width vs pointer). */
export const fakeMatchMedia = {
  install(matches: boolean, { coarse = false } = {}) {
    const state = { width: matches, coarse };
    const listeners = new Set<Listener>();
    window.matchMedia = ((query: string) => {
      const pick = () => (query.includes("pointer") ? state.coarse : state.width);
      return {
        get matches() {
          return pick();
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, l: Listener) => listeners.add(l),
        removeEventListener: (_: string, l: Listener) => listeners.delete(l),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    return {
      set(next: boolean) {
        state.width = next;
        for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
      },
      setCoarse(next: boolean) {
        state.coarse = next;
      },
    };
  },
  /** A viewport `px` wide (1rem = 16px): `(width >= 64rem)`-style queries answer from it. */
  installWidth(px: number) {
    const state = { px };
    const listeners = new Set<Listener>();
    const answer = (query: string) => {
      const m = /\(width\s*(>=|<=|<|>)\s*([\d.]+)(rem|px)\)/.exec(query);
      if (!m) return false;
      const v = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
      const w = state.px;
      return m[1] === ">=" ? w >= v : m[1] === "<=" ? w <= v : m[1] === "<" ? w < v : w > v;
    };
    window.matchMedia = ((query: string) =>
      ({
        get matches() {
          return answer(query);
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, l: Listener) => listeners.add(l),
        removeEventListener: (_: string, l: Listener) => listeners.delete(l),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    return {
      set(next: number) {
        state.px = next;
        for (const l of [...listeners]) l({ matches: false } as MediaQueryListEvent);
      },
    };
  },
};
