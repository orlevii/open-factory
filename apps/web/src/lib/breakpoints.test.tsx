import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeMatchMedia } from "../test/fake-match-media";
import { MOBILE, useMedia, WIDE, XWIDE } from "./breakpoints";
import { INBOX_DWELL_MS } from "./timing";

test("breakpoints are rem queries", () => {
  expect(MOBILE).toBe("(width < 48rem)");
  expect(WIDE).toBe("(width >= 64rem)");
  expect(XWIDE).toBe("(width >= 80rem)");
  expect(INBOX_DWELL_MS).toBe(1000);
});

test("useMedia follows the fake matchMedia", () => {
  const fake = fakeMatchMedia.install(false);
  const { result } = renderHook(() => useMedia(XWIDE));
  expect(result.current).toBe(false);
  act(() => fake.set(true));
  expect(result.current).toBe(true);
});

test("useMedia reads the right value on first render and per query", () => {
  fakeMatchMedia.install(true);
  const a = renderHook(() => useMedia(WIDE));
  expect(a.result.current).toBe(true);
});
