import { expect, test } from "vitest";
import { formatScheduleTime } from "./format";

const now = new Date("2026-11-20T10:00:00Z");

test("weekday, day, month and 24h time in the schedule's zone; the zone is returned apart", () => {
  const f = formatScheduleTime(new Date("2026-11-23T08:00:00Z"), "Europe/Berlin", now);
  expect(f).toEqual({
    text: "Mon 23 Nov 09:00",
    zone: "Europe/Berlin",
    iso: "2026-11-23T08:00:00.000Z",
  });
});
test("the year shows only when it isn't the current one", () => {
  expect(formatScheduleTime(new Date("2028-01-04T08:00:00Z"), "Europe/Berlin", now).text).toBe(
    "Tue 4 Jan 2028 09:00",
  );
  // "current" is read in the schedule's zone: 31 Dec 23:30 UTC is already 2027 in Berlin
  expect(
    formatScheduleTime(
      new Date("2026-12-31T23:30:00Z"),
      "Europe/Berlin",
      new Date("2026-12-31T23:30:00Z"),
    ).text,
  ).toBe("Fri 1 Jan 00:30");
});
