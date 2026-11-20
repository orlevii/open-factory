import { expect, test } from "vitest";
import { formatBytes, formatResetTime, formatTokens } from "./format";

test("tokens", () => {
  expect(formatTokens(27545)).toBe("27.5k");
  expect(formatTokens(15259)).toBe("15.3k");
  expect(formatTokens(129052)).toBe("129k");
  expect(formatTokens(950)).toBe("950");
});
test("bytes", () => {
  expect(formatBytes(1_200_000)).toBe("1.2 MB");
  expect(formatBytes(70_000)).toBe("70 KB");
});
test("formatResetTime", () => {
  expect(formatResetTime(new Date(2026, 10, 19, 14, 30), new Date(2026, 10, 19, 9))).toBe("14:30");
  expect(formatResetTime(new Date(2026, 10, 20, 9, 10), new Date(2026, 10, 19, 9))).toBe(
    "Fri 09:10",
  );
  expect(formatResetTime(new Date(2026, 10, 25, 9, 10), new Date(2026, 10, 19, 9))).toBe(
    "Wed 09:10",
  );
  expect(formatResetTime(new Date(2026, 10, 27, 9, 10), new Date(2026, 10, 19, 9))).toBe(
    "27 Nov 09:10",
  );
});
