import { expect, test } from "vitest";
import { isSendKey } from "./send-key";

test.each([
  [{ key: "Enter" }, false, true],
  [{ key: "Enter", shiftKey: true }, false, false],
  [{ key: "Enter", metaKey: true }, false, true],
  [{ key: "Enter", ctrlKey: true }, true, true],
  [{ key: "Enter" }, true, false],
  [{ key: "Enter", isComposing: true }, false, false],
  [{ key: "Enter", keyCode: 229 }, false, false],
  [{ key: "a" }, false, false],
])("%o coarse=%s → %s", (e, coarse, expected) => {
  expect(
    isSendKey(
      { shiftKey: false, metaKey: false, ctrlKey: false, keyCode: 13, isComposing: false, ...e },
      coarse,
    ),
  ).toBe(expected);
});
