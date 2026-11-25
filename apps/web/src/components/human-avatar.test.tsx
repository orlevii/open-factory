import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { HumanAvatar, initialsOf } from "./human-avatar";

test.each([
  ["Ada Lovelace", "AL"],
  ["Martin Luther King Jr.", "MK"],
  ["Henry Ford III", "HF"],
  ["ada", "A"],
  ["Jr", "J"],
  ["  ada   byron  lovelace ", "AL"],
  ["李雷", "李"],
  ["Åsa Ölund", "ÅÖ"],
  ["😀 Ada", "A"],
  ["José 🎉", "J"],
  ["émile zola", "ÉZ"],
])("initials of %s are %s", (name, initials) => {
  expect(initialsOf(name)).toBe(initials);
});

test.each(["", "   ", "😀", "123 456"])("a name with no letters (%j) has no initials", (name) => {
  expect(initialsOf(name)).toBe("");
});

test("the avatar shows the initials, hidden from assistive tech", () => {
  const { container } = render(<HumanAvatar name="Ada Lovelace" />);
  const el = container.querySelector("[data-human-avatar]");
  expect(el).toHaveTextContent("AL");
  expect(el).toHaveAttribute("aria-hidden", "true");
});

test("a name with no letters falls back to a person glyph with no text", () => {
  const { container } = render(<HumanAvatar name="" />);
  const el = container.querySelector("[data-human-avatar]");
  expect(el).toHaveTextContent("");
  expect(el?.querySelector("svg")).not.toBeNull();
});
