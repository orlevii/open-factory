import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Checkbox } from "./checkbox";

test.each([true, false])("a disabled checkbox (checked=%s) keeps its state on click", async (checked) => {
  render(<Checkbox disabled defaultChecked={checked} aria-label="Pick" />);
  const box = screen.getByRole("checkbox", { name: "Pick" });
  expect(box).toBeDisabled();
  const state = checked ? "checked" : "unchecked";
  expect(box).toHaveAttribute("data-state", state);
  await userEvent.click(box);
  expect(box).toHaveAttribute("data-state", state);
});
