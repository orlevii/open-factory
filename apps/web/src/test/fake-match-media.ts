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
};
