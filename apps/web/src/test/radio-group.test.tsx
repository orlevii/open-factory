import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

function Group({ onValueChange }: { onValueChange?: (v: string) => void }) {
  return (
    <RadioGroup defaultValue="a" aria-label="Pick" onValueChange={onValueChange}>
      <RadioGroupItem value="a" aria-label="A" />
      <RadioGroupItem value="b" aria-label="B" />
      <RadioGroupItem value="c" aria-label="C" disabled />
    </RadioGroup>
  );
}

test("clicking selects, and arrow keys move selection past disabled items", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(<Group onValueChange={onValueChange} />);
  expect(screen.getByRole("radio", { name: "A" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "B" }));
  expect(screen.getByRole("radio", { name: "B" })).toBeChecked();
  expect(onValueChange).toHaveBeenLastCalledWith("b");
  // Roving focus: ArrowDown from B skips the disabled C and wraps to A; Space then selects it.
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("radio", { name: "A" })).toHaveFocus();
  await user.keyboard(" ");
  expect(screen.getByRole("radio", { name: "A" })).toBeChecked();
  expect(onValueChange).toHaveBeenLastCalledWith("a");
});

test("a disabled radio is muted and cannot be selected", async () => {
  const user = userEvent.setup();
  render(<Group />);
  const c = screen.getByRole("radio", { name: "C" });
  expect(c).toBeDisabled();
  expect(c).toHaveClass("disabled:bg-muted", "disabled:text-muted-foreground");
  await user.click(c);
  expect(c).not.toBeChecked();
});
