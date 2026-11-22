import { expect, test } from "vitest";
import {
  atPhrase,
  formatBytes,
  formatDay,
  formatDuration,
  formatResetTime,
  formatTokens,
} from "./format";

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

test("formatDay: a local calendar day, the year only when it isn't this year", () => {
  const now = new Date(2026, 10, 20, 10);
  expect(formatDay(new Date(2026, 10, 19, 23, 59), now)).toBe("19 Nov");
  expect(formatDay(new Date(2026, 10, 22, 14, 32), now)).toBe("22 Nov");
  expect(formatDay(new Date(2025, 11, 31, 8), now)).toBe("31 Dec 2025");
});

test("atPhrase: local time with the preposition its output needs, past and future", () => {
  const now = new Date(2026, 10, 19, 15, 0); // Thu
  const at = (d: number, h = 14, m = 32, y = 2026) => new Date(y, 10, d, h, m);
  expect(atPhrase(at(19), now)).toBe("today at 14:32");
  expect(atPhrase(at(18), now)).toBe("yesterday at 14:32");
  expect(atPhrase(at(14), now)).toBe("on 14 Nov at 14:32");
  expect(atPhrase(at(14, 14, 32, 2025), now)).toBe("on 14 Nov 2025 at 14:32");
  expect(atPhrase(at(19, 16, 5), now)).toBe("today at 16:05");
  expect(atPhrase(at(22), now)).toBe("on Sun at 14:32");
  expect(atPhrase(at(28), now)).toBe("on 28 Nov at 14:32");
});

test.each([
  [0, "0s"],
  [42_000, "42s"],
  [69_000, "1m 09s"],
  [133_000, "2m 13s"],
  [3_780_000, "1h 03m"],
  [-5_000, "0s"],
])("formatDuration %i -> %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
