import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

test("arrow keys move the selection and report typed values", async () => {
  const onChange = vi.fn();
  render(<SegmentedControl legend="Range" name="r" value={7} onChange={onChange}
    options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }]} />);
  const seven = screen.getByRole("radio", { name: "7 days" });
  seven.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith(30);
});
test("the track grows to a touch target; segments keep a border so selection never shifts", () => {
  const { container } = render(<SegmentedControl legend="Show" name="s" value="a" onChange={() => {}}
    options={[{ value: "a", label: "Active" }, { value: "b", label: "Ended" }]} size="sm" />);
  const track = container.querySelector("[data-slot=segmented-track]");
  expect(track).toHaveClass("pointer-coarse:h-9");
  for (const l of container.querySelectorAll("label")) expect(l).toHaveClass("border");
});
test("the legend is visible only when asked", () => {
  render(<SegmentedControl legend="When" legendVisible name="w" value="a" onChange={() => {}} options={[{ value: "a", label: "Repeats" }]} />);
  expect(screen.getByText("When")).not.toHaveClass("sr-only");
});
