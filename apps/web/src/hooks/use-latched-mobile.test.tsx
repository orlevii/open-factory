import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { fakeMatchMedia } from "../test/fake-match-media";
import { useLatchedMobile } from "./use-latched-mobile";

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

test("keeps the primitive chosen at open until it closes", () => {
  const mm = fakeMatchMedia.install(false);
  const { result, rerender } = renderHook(({ open }) => useLatchedMobile(open), {
    initialProps: { open: true },
  });
  expect(result.current).toBe(false);
  act(() => mm.set(true));
  rerender({ open: true });
  expect(result.current).toBe(false);
  rerender({ open: false });
  expect(result.current).toBe(false);
  act(() => mm.set(false));
  expect(result.current).toBe(false);
  act(() => mm.set(true));
  rerender({ open: true });
  expect(result.current).toBe(true);
});

test("a closed host does not re-render on a resize", () => {
  const mm = fakeMatchMedia.install(false);
  let renders = 0;
  renderHook(() => {
    renders++;
    return useLatchedMobile(false);
  });
  const before = renders;
  act(() => mm.set(true));
  expect(renders).toBe(before);
});
