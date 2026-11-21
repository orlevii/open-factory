import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

async function sequence(contentSlot: string) {
  const trigger = screen.getByRole("button", { name: "Open" });
  const content = () => document.querySelector(`[data-slot="${contentSlot}"]`);
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
  await closed();
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
}

test("DropdownMenu is stamped per opening, not per mount", async () => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>One</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await sequence("dropdown-menu-content");
});

test("Popover is stamped per opening, not per mount", async () => {
  render(
    <Popover>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Body</PopoverContent>
    </Popover>,
  );
  await sequence("popover-content");
});

test("TooltipProvider opens after 400ms", () => {
  vi.useFakeTimers();
  try {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    fireEvent.pointerMove(screen.getByText("Hover"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
