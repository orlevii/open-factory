import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { MoreOptions } from "./more-options";

let openFromOutside: (open: boolean) => void = () => {};
function Harness() {
  const [open, setOpen] = useState(false);
  openFromOutside = setOpen;
  return (
    <MoreOptions open={open} onOpenChange={setOpen}>
      <p>Inner</p>
    </MoreOptions>
  );
}
const toggle = () => screen.getByRole("button", { name: "More options" });
const chevron = () => toggle().querySelector("[data-slot=more-options-chevron]") as Element;
const animates = () => chevron().classList.contains("transition-transform");

test("a click animates the chevron; an outside open after a fold is instant", async () => {
  render(<Harness />);
  await userEvent.click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(animates()).toBe(true);
  expect(chevron()).not.toHaveAttribute("data-instant");
  await userEvent.click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "false");
  expect(animates()).toBe(true);
  // A failing submit reopens it.
  act(() => openFromOutside(true));
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  expect(animates()).toBe(false);
  expect(chevron()).toHaveAttribute("data-instant");
});

test("an outside close then reopen after a click-open is instant too", async () => {
  render(<Harness />);
  await userEvent.click(toggle());
  act(() => openFromOutside(false));
  act(() => openFromOutside(true));
  expect(animates()).toBe(false);
  expect(chevron()).toHaveAttribute("data-instant");
});
