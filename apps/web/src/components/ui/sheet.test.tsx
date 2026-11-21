import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "./sheet";

function Demo({ onOpenChange = () => {} }: { onOpenChange?: (o: boolean) => void }) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New task</SheetTitle>
        </SheetHeader>
        <SheetBody>body</SheetBody>
        <SheetFooter>
          <button type="button">Create</button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

test("desktop: a right panel with a header close, full travel, no fade, no shadow", () => {
  fakeMatchMedia.install(false);
  render(<Demo />);
  const panel = screen.getByRole("dialog", { name: "New task" });
  expect(panel).toHaveAttribute("data-slot", "sheet-content");
  expect(panel.className).toMatch(/slide-in-from-right/);
  // No panel fade except under reduced motion (checked per class token).
  const fades = panel.className.split(/\s+/).filter((c) => /fade-(in|out)/.test(c));
  expect(fades.filter((c) => !c.startsWith("motion-reduce:"))).toEqual([]);
  expect(panel.className).toMatch(/motion-reduce:data-open:fade-in-0/);
  expect(panel.className).not.toMatch(/shadow-/);
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
});

test("Esc closes", async () => {
  fakeMatchMedia.install(false);
  const onOpenChange = vi.fn();
  render(<Demo onOpenChange={onOpenChange} />);
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("mobile: a bottom drawer with the same slots", () => {
  fakeMatchMedia.install(true);
  render(<Demo />);
  expect(document.querySelector("[data-slot=drawer-content]")).toBeInTheDocument();
  expect(screen.getByText("New task")).toBeInTheDocument();
});

test("crossing the breakpoint while open keeps the primitive", () => {
  const mm = fakeMatchMedia.install(false);
  render(<Demo />);
  act(() => mm.set(true));
  expect(document.querySelector("[data-slot=sheet-content]")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
});
