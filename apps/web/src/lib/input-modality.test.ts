import { afterEach, expect, test } from "vitest";
import { installInputModality, lastInputModality, stampInstant } from "./input-modality";

let off = () => {};
afterEach(() => off());

test("records the last input", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(lastInputModality()).toBe("keyboard");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(lastInputModality()).toBe("pointer");
});

test("modifier-only keys do not count as keyboard input", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
  expect(lastInputModality()).toBe("pointer");
});

test("stampInstant stamps a node that mounts after keyboard input, and only then", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const a = document.createElement("div");
  stampInstant(a);
  expect(a).toHaveAttribute("data-instant");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const b = document.createElement("div");
  stampInstant(b);
  expect(b).not.toHaveAttribute("data-instant");
  stampInstant(null);
});
