import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LinkEditor, newLinkRow } from "./link-editor";

test("the kind list is not a blur: rows are checked after it closes, not while it is open", async () => {
  const onBlurRow = vi.fn();
  render(
    <TooltipProvider>
      <LinkEditor rows={[newLinkRow()]} onChange={() => {}} errors={{}} onBlurRow={onBlurRow} />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Link 1 kind" }));
  await screen.findByRole("listbox");
  expect(onBlurRow).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(onBlurRow).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(onBlurRow).toHaveBeenCalledTimes(1);
});
