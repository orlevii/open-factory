import { expect, test } from "vitest";
import {
  countRuns,
  factoryZoneDefault,
  formatOffsetIso,
  isValidZone,
  latestAtOrBefore,
  minGapMinutes,
  nextRun,
  nextRuns,
  parseAt,
  validateCron,
} from "./cron.ts";

const iso = (d: Date | null) => d?.toISOString();
const B = "Europe/Berlin";
const NY = "America/New_York";

test.each([
  "0 9 * * 1-5",
  "*/30 * * * *",
  "0 8 1 * *",
  "0,30 2 * * *",
  "0 9 * jan mon",
  "0 9 * * 7",
  "5-10/2 * * * *",
])("accepts %s", (e) => expect(validateCron(e)).toBeNull());

test.each([
  ["0 9 * *", "Use 5 fields, like 0 9 * * 1-5."],
  ["0 0 9 * * *", "Use 5 fields, like 0 9 * * 1-5."],
  ["@daily", "Use 5 fields, like 0 9 * * 1-5."],
  ["0 9 L * *", "Use numbers, *, -, / and commas."],
  ["0 9 * * 5#2", "Use numbers, *, -, / and commas."],
  ["0 9 ? * *", "Use numbers, *, -, / and commas."],
  ["0 9 15W * *", "Use numbers, *, -, / and commas."],
  ["0 0 30 2 *", "This pattern never runs."],
])("refuses %s", (e, msg) => expect(validateCron(e)).toBe(msg));

test("a field error names the field", () => expect(validateCron("61 * * * *")).toMatch(/minute/i));

test("zones", () => {
  expect(isValidZone(B)).toBe(true);
  expect(isValidZone("UTC")).toBe(true);
  expect(isValidZone("Mars/Base")).toBe(false);
  expect(isValidZone("")).toBe(false);
  expect(isValidZone(factoryZoneDefault())).toBe(true);
});

// DST pins (spec 7.2), 2026 transitions. Berlin: spring 29 Mar 02:00 -> 03:00, fall 25 Oct 03:00 -> 02:00.
test("Berlin spring-forward: 02:30 runs at 03:00 once", () => {
  expect(nextRuns("30 2 * * *", B, new Date("2026-03-28T12:00:00Z"), 2).map(iso)).toEqual([
    "2026-03-29T01:00:00.000Z",
    "2026-03-30T00:30:00.000Z",
  ]);
});
test("Berlin fall-back: a single fixed time runs once", () => {
  expect(nextRuns("30 2 * * *", B, new Date("2026-10-24T12:00:00Z"), 2).map(iso)).toEqual([
    "2026-10-25T00:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
  ]);
});
test("Berlin fall-back: a list hitting the repeated hour runs at both repeats", () => {
  expect(nextRuns("0,30 2 * * *", B, new Date("2026-10-24T12:00:00Z"), 4).map(iso)).toEqual([
    "2026-10-25T00:00:00.000Z",
    "2026-10-25T00:30:00.000Z",
    "2026-10-25T01:00:00.000Z",
    "2026-10-25T01:30:00.000Z",
  ]);
});
test("New York transitions (8 Mar, 1 Nov 2026)", () => {
  expect(iso(nextRun("30 2 * * *", NY, new Date("2026-03-07T12:00:00Z")))).toBe(
    "2026-03-08T07:00:00.000Z",
  );
  expect(iso(nextRun("30 1 * * *", NY, new Date("2026-10-31T12:00:00Z")))).toBe(
    "2026-11-01T05:30:00.000Z",
  );
});
test("parseAt: offset wins; no offset is read in the zone; a missing wall time becomes 03:30", () => {
  expect(iso(parseAt("2026-11-23T09:00:00+01:00", NY))).toBe("2026-11-23T08:00:00.000Z");
  expect(iso(parseAt("2026-11-23T09:00", B))).toBe("2026-11-23T08:00:00.000Z");
  expect(iso(parseAt("2026-03-29T02:30", B))).toBe("2026-03-29T01:30:00.000Z");
  expect(iso(parseAt("2026-11-23T09:00:00Z", B))).toBe("2026-11-23T09:00:00.000Z");
  expect(parseAt("not a date", B)).toBeNull();
});
test("occurrence math (spec 8.1 step 3)", () => {
  const e = "0 9 * * 1-5";
  const from = new Date("2026-11-24T08:00:00Z");
  const now = new Date("2026-11-27T10:40:00Z");
  expect(countRuns(e, B, from, now)).toBe(4);
  expect(iso(latestAtOrBefore(e, B, now))).toBe("2026-11-27T08:00:00.000Z");
  expect(iso(latestAtOrBefore(e, B, new Date("2026-11-27T08:00:00Z")))).toBe(
    "2026-11-27T08:00:00.000Z",
  );
  expect(countRuns("* * * * *", B, from, now)).toBe(1000);
});
test("minGapMinutes", () => {
  const t = new Date("2026-11-20T10:00:00Z");
  expect(minGapMinutes("*/15 * * * *", B, t)).toBe(15);
  expect(minGapMinutes("*/5 * * * *", B, t)).toBe(5);
  expect(minGapMinutes("0 9 * * *", B, t)).toBe(1440);
});
test("formatOffsetIso", () => {
  expect(formatOffsetIso(new Date("2026-11-23T08:00:00Z"), B)).toBe("2026-11-23T09:00:00+01:00");
  expect(formatOffsetIso(new Date("2026-07-01T07:00:00Z"), B)).toBe("2026-07-01T09:00:00+02:00");
  expect(formatOffsetIso(new Date("2026-07-01T07:00:00Z"), "UTC")).toBe(
    "2026-07-01T07:00:00+00:00",
  );
});

test("review 5: parseAt refuses impossible fields, including seconds above 59", () => {
  expect(parseAt("2026-11-23T09:00:61", B)).toBeNull();
  expect(parseAt("2026-11-23T09:60", B)).toBeNull();
  expect(parseAt("2026-11-23T24:00", B)).toBeNull();
  expect(parseAt("2026-02-30T09:00", B)).toBeNull();
  expect(iso(parseAt("2026-11-23T09:00:59", B))).toBe("2026-11-23T08:00:59.000Z");
});
