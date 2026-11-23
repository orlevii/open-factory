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
