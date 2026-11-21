import { afterEach, expect, test, vi } from "vitest";
import { runInstant, runInstantOn } from "./run-instant";

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

test("runInstantOn marks only that element and clears it two frames later", () => {
  const flush = manualFrames();
  const a = document.createElement("div");
  const b = document.createElement("div");
  let during: string | undefined;
  runInstantOn(a, () => {
    during = a.dataset.instant;
  });
  expect(during).toBe("");
  expect(b.dataset.instant).toBeUndefined();
  expect(document.documentElement.dataset.instant).toBeUndefined();
  flush();
  expect(a.dataset.instant).toBeUndefined();
});

test("runInstantOn clears the flag even when fn throws", () => {
  const flush = manualFrames();
  const a = document.createElement("div");
  expect(() =>
    runInstantOn(a, () => {
      throw new Error("x");
    }),
  ).toThrow("x");
  flush();
  expect(a.dataset.instant).toBeUndefined();
});
