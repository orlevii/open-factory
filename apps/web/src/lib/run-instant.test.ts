import { afterEach, expect, test, vi } from "vitest";
import { runInstant } from "./run-instant";

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.instant;
});

function manualFrames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  return () => {
    for (let cb = queue.shift(); cb; cb = queue.shift()) cb(0);
  };
}

test("marks the root instant while fn runs and clears it two frames later", () => {
  const flush = manualFrames();
  let during: string | undefined;
  runInstant(() => {
    during = document.documentElement.dataset.instant;
  });
  expect(during).toBe("");
  expect(document.documentElement.dataset.instant).toBe("");
  flush();
  expect(document.documentElement.dataset.instant).toBeUndefined();
});

test("a throwing fn still clears the flag and rethrows", () => {
  const flush = manualFrames();
  expect(() =>
    runInstant(() => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  flush();
  expect(document.documentElement.dataset.instant).toBeUndefined();
});
