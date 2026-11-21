import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

function fakeMatchMedia(initial: boolean) {
  const state = { matches: initial, listeners: new Set<() => void>() };
  window.matchMedia = vi.fn(
    (media: string) =>
      ({
        get matches() {
          return state.matches;
        },
        media,
        addEventListener: (_: string, l: () => void) => state.listeners.add(l),
        removeEventListener: (_: string, l: () => void) => state.listeners.delete(l),
      }) as unknown as MediaQueryList,
  );
  return {
    set(matches: boolean) {
      state.matches = matches;
      for (const l of state.listeners) l();
    },
  };
}

test("the first render already reports a phone-sized viewport", () => {
  fakeMatchMedia(true);
  const seen: boolean[] = [];
  renderHook(() => {
    const v = useIsMobile();
    seen.push(v);
    return v;
  });
  expect(seen[0]).toBe(true);
  expect(seen.every(Boolean)).toBe(true);
});

test("follows media query changes", () => {
  const mq = fakeMatchMedia(false);
  const { result } = renderHook(() => useIsMobile());
  expect(result.current).toBe(false);
  act(() => mq.set(true));
  expect(result.current).toBe(true);
});
