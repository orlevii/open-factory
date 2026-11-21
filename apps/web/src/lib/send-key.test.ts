import { expect, test } from "vitest";
import { isSendKey, isUrgentSendKey } from "./send-key";

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

const enter = {
  key: "Enter",
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  keyCode: 13,
  isComposing: false,
};

test("Alt+Enter is urgent; isSendKey still also matches it, so urgent is checked first", () => {
  const alt = { ...enter, altKey: true };
  expect(isUrgentSendKey(alt, false)).toBe(true);
  expect(isSendKey(alt, false)).toBe(true);
  expect(isUrgentSendKey(enter, false)).toBe(false);
  expect(isUrgentSendKey({ ...enter, metaKey: true }, false)).toBe(false);
  expect(isUrgentSendKey({ ...enter, altKey: true, isComposing: true }, false)).toBe(false);
  expect(isUrgentSendKey({ ...enter, altKey: true, keyCode: 229 }, false)).toBe(false);
  expect(isUrgentSendKey({ ...enter, altKey: true }, true)).toBe(false); // coarse pointer
  expect(isUrgentSendKey({ ...enter, key: "a", altKey: true }, false)).toBe(false);
});
