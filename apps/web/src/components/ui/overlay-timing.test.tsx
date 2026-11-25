import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "./alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "./popover";
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

test("Esc closes a pointer-opened Popover instantly", async () => {
  render(
    <Popover>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Body</PopoverContent>
    </Popover>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  const content = document.querySelector('[data-slot="popover-content"]') as HTMLElement;
  expect(content).not.toHaveAttribute("data-instant");
  const seen: (string | null)[] = [];
  const obs = new MutationObserver((records) => seen.push(...records.map((m) => m.attributeName)));
  obs.observe(content, { attributes: true, attributeFilter: ["data-instant", "data-state"] });
  await userEvent.keyboard("{Escape}");
  obs.disconnect();
  // Stamped before the closed state, so the exit animation is skipped.
  expect(seen[0]).toBe("data-instant");
});

test("an Esc the caller prevents leaves a pointer-opened Popover open and unstamped", async () => {
  render(
    <Popover>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent onEscapeKeyDown={(e) => e.preventDefault()}>Body</PopoverContent>
    </Popover>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.keyboard("{Escape}");
  const content = document.querySelector('[data-slot="popover-content"]');
  expect(content).toHaveAttribute("data-state", "open");
  expect(content).not.toHaveAttribute("data-instant");
});

test("PopoverTitle and PopoverDescription name and describe the content", async () => {
  render(
    <Popover>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>Name</PopoverTitle>
        <PopoverDescription>Desc</PopoverDescription>
      </PopoverContent>
    </Popover>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("dialog", { name: "Name" })).toHaveAccessibleDescription("Desc");
});

test("AlertDialog content and overlay are stamped per opening, not per mount", async () => {
  render(
    <AlertDialog>
      <AlertDialogPrimitive.Trigger>Open</AlertDialogPrimitive.Trigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete?</AlertDialogTitle>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
      </AlertDialogContent>
    </AlertDialog>,
  );
  await sequence("alert-dialog-content");
  expect(document.querySelector("[data-slot=alert-dialog-overlay]")).toHaveAttribute("data-instant");
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
