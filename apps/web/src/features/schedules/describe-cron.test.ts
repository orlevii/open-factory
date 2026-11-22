import { expect, test } from "vitest";
import { describeCron, presetOf, REPEATS_PRESETS } from "./describe-cron";

test.each([
  ["*/15 * * * *", "Every 15 minutes"],
  ["*/7 * * * *", undefined],
  ["0 */6 * * *", "Every 6 hours"],
  ["0 */5 * * *", undefined],
  ["30 * * * *", "Every hour at :30"],
  ["0 9 * * *", "Daily at 09:00"],
  ["5 17 * * 1-5", "Weekdays at 17:05"],
  ["0 9 * * 1,4", "Mondays and Thursdays at 09:00"],
  ["0 9 * * 0", "Sundays at 09:00"],
  ["0 9 * * 7", "Sundays at 09:00"],
  ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 09:00"],
  ["0 9 * * 1,2,3,4", undefined],
  ["0 8 1 * *", "Monthly on the 1st at 08:00"],
  ["0 8 22 * *", "Monthly on the 22nd at 08:00"],
  ["0 8 23 * *", "Monthly on the 23rd at 08:00"],
  ["0 8 11 * *", "Monthly on the 11th at 08:00"],
  ["0 8 29 * *", undefined],
  ["0 9 * * 1-3", undefined],
  ["0 9 1 1 *", undefined],
  ["nonsense", undefined],
])("%s → %s", (c, out) => expect(describeCron(c)).toBe(out));

test("presets", () => {
  expect(REPEATS_PRESETS.map((p) => p.cron)).toEqual([
    "0 * * * *",
    "0 9 * * *",
    "0 9 * * 1-5",
    "0 9 * * 1",
  ]);
  expect(presetOf("0 9 * * 1-5")).toBe("Weekdays at 09:00");
  expect(presetOf("0 9 * * 2")).toBeUndefined();
});
