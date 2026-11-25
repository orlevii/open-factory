import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { ALL, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

test("keyboard selection calls onValueChange; the sentinel stands for 'all'", async () => {
  const onChange = vi.fn();
  render(
    <Select value={ALL} onValueChange={onChange}>
      <SelectTrigger aria-label="Agent"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All agents</SelectItem>
        <SelectItem value="dev-001" textValue="dev-001">Developer One (@dev-001)</SelectItem>
      </SelectContent>
    </Select>,
  );
  const trigger = screen.getByRole("combobox", { name: "Agent" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("dev-001");
});

test("Select is stamped per opening, not per mount", async () => {
  render(
    <Select>
      <SelectTrigger aria-label="Pick"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="a">A</SelectItem></SelectContent>
    </Select>,
  );
  const trigger = screen.getByRole("combobox", { name: "Pick" });
  const content = () => document.querySelector('[data-slot="select-content"]');
  const closed = async () => {
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(content()).toBeNull());
  };
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
  await closed();
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(content()).not.toBeNull());
  expect(content()).not.toHaveAttribute("data-instant");
});
