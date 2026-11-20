import { expect, test } from "vitest";
import { blockedBy, isBlocked } from "./blocked.ts";

test("blocked only while open or in progress with an unsettled dependency", () => {
  expect(isBlocked("open", ["open"])).toBe(true);
  expect(isBlocked("in_progress", ["done", "cancelled"])).toBe(false);
  expect(isBlocked("in_progress", ["done", "in_progress"])).toBe(true);
  expect(isBlocked("done", ["open"])).toBe(false);
  expect(isBlocked("cancelled", ["open"])).toBe(false);
});
test("blockedBy lists the unsettled dependencies' keys", () => {
  expect(
    blockedBy("open", [
      { key: "T-1", status: "done" },
      { key: "T-2", status: "open" },
      { key: "T-3", status: "in_progress" },
      { key: "T-4", status: "cancelled" },
    ]),
  ).toEqual(["T-2", "T-3"]);
  expect(blockedBy("done", [{ key: "T-2", status: "open" }])).toEqual([]);
});
