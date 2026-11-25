import { expect, test } from "vitest";
import { minutesSince, pairOf } from "./loop-guard.ts";

test("pairOf orders the two ids whichever way they come", () => {
  expect(pairOf("a2", "a1")).toEqual({ a: "a1", b: "a2" });
  expect(pairOf("a1", "a2")).toEqual({ a: "a1", b: "a2" });
});

test("minutesSince rounds up and is never below one", () => {
  const now = new Date("2026-01-01T00:10:00Z");
  expect(minutesSince(new Date("2026-01-01T00:09:59Z"), now)).toBe(1);
  expect(minutesSince(now, now)).toBe(1);
  expect(minutesSince(new Date("2026-01-01T00:07:30Z"), now)).toBe(3);
  expect(minutesSince(new Date("2026-01-01T00:00:00Z"), now)).toBe(10);
});
