import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeMatchMedia } from "../test/fake-match-media";
import { MOBILE, useMedia, WIDE, XWIDE } from "./breakpoints";

test("the breakpoints are distinct rem-based queries", () => {
  const all = [MOBILE, WIDE, XWIDE];
  expect(new Set(all).size).toBe(3);
  for (const q of all) expect(q).toContain("rem");
});

test("useMedia follows the fake matchMedia", () => {
  const fake = fakeMatchMedia.install(false);
  const { result } = renderHook(() => useMedia(XWIDE));
  expect(result.current).toBe(false);
  act(() => fake.set(true));
  expect(result.current).toBe(true);
});

test("useMedia reads the right value on first render, for each query", () => {
  fakeMatchMedia.install(true);
  const asked: string[] = [];
  const inner = window.matchMedia;
  window.matchMedia = ((q: string) => {
    asked.push(q);
    return inner(q);
  }) as typeof window.matchMedia;
  const wide = renderHook(() => useMedia(WIDE));
  const xwide = renderHook(() => useMedia(XWIDE));
  expect(wide.result.current).toBe(true);
  expect(xwide.result.current).toBe(true);
  expect(asked).toContain(WIDE);
  expect(asked).toContain(XWIDE);
});
