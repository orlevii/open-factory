import { expect, test } from "vitest";
import { formatTokens } from "@/features/session/format";
import { formatCost, formatCostEst, formatDayShort, niceMax, parseDay } from "./format";

test("formatCost", () => {
  expect(formatCost(0.004, 1)).toBe("<$0.01");
  expect(formatCost(0, 3)).toBe("$0.00");
  expect(formatCost(0, 0)).toBe("—");
  expect(formatCost(12.345, 1)).toBe("$12.35");
  expect(formatCost(1234.5, 1)).toBe("$1,235");
  // Rounded to cents before choosing the format.
  expect(formatCost(0.995, 1)).toBe("$1.00");
  expect(formatCost(999.995, 1)).toBe("$1,000");
  expect(formatCost(999.996, 1)).toBe("$1,000");
  expect(formatCost(999.994, 1)).toBe("$999.99");
  expect(formatCost(0.0049, 1)).toBe("<$0.01");
});

test("formatCostEst adds the suffix except on a dash", () => {
  expect(formatCostEst(12.345, 1)).toBe("$12.35 est.");
  expect(formatCostEst(0, 0)).toBe("—");
});

test("formatTokens gains M", () => {
  expect(formatTokens(1_234_567)).toBe("1.2M");
  expect(formatTokens(123_456)).toBe("123k");
  expect(formatTokens(999_499)).toBe("999k");
  expect(formatTokens(999_500)).toBe("1.0M");
  expect(formatTokens(999_999)).toBe("1.0M");
  expect(formatTokens(99_949)).toBe("99.9k");
  expect(formatTokens(99_950)).toBe("100k");
});

test("days are parsed and shown without a zone shift", () => {
  expect(parseDay("2026-11-20")).toEqual({ y: 2026, m: 11, d: 20 });
  const wd = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
    Date.UTC(2026, 10, 20),
  );
  expect(formatDayShort("2026-11-20")).toBe(`${wd} 20 Nov`);
});

test("every month is three letters (en-GB ICU writes September as Sept)", () => {
  expect(formatDayShort("2026-09-11")).toMatch(/^\w{3} 11 Sep$/);
  expect(formatDayShort("2026-06-01")).toMatch(/^\w{3} 1 Jun$/);
});

test("niceMax rounds up to 1/2/5 x 10^n", () => {
  expect(niceMax(3.21)).toBe(5);
  expect(niceMax(12)).toBe(20);
  expect(niceMax(5)).toBe(5);
  expect(niceMax(0.07)).toBe(0.1);
  expect(niceMax(0)).toBe(1);
});
