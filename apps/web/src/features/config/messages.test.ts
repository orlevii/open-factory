import { expect, test } from "vitest";
import { CONFIG_FIELD_MSG } from "./messages";

test("every configuration field message is at most 40 characters", () => {
  for (const [k, m] of Object.entries(CONFIG_FIELD_MSG))
    expect(m.length, k).toBeLessThanOrEqual(40);
});

test("the spec's copy, verbatim", () => {
  expect(CONFIG_FIELD_MSG.duplicate).toBe("Already in the list.");
  expect(CONFIG_FIELD_MSG.editInRaw).toBe("Edit this in Raw JSON.");
  expect(CONFIG_FIELD_MSG.alsoChanged).toBe("Also changed elsewhere.");
});
