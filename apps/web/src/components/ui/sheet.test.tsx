import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "./sheet";

function Demo({ open = true, onOpenChange = () => {} }: { open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
  const tokens = panel.className.split(/\s+/);
  expect(tokens).toContain("data-open:slide-in-from-right");
  expect(tokens).toContain("data-closed:slide-out-to-right");
  // Full travel: no partial distance such as slide-in-from-right-10.
  expect(tokens.filter((c) => /slide-(in-from|out-to)-right-/.test(c))).toEqual([]);
  // No panel fade except under reduced motion (checked per class token).
  const fades = tokens.filter((c) => /fade-(in|out)/.test(c));
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

test("mobile: Esc closes", async () => {
  fakeMatchMedia.install(true);
  const onOpenChange = vi.fn();
  render(<Demo onOpenChange={onOpenChange} />);
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("mobile: the body is the drawer body and keeps scrolling on short screens", () => {
  fakeMatchMedia.install(true);
  render(<Demo />);
  const body = screen.getByText("body");
  expect(body).toHaveAttribute("data-slot", "drawer-body");
  expect(body.className).toMatch(/overflow-y-auto/);
  expect(body.className).not.toMatch(/overflow-visible/);
});

test("crossing the breakpoint while open keeps the primitive, even across re-renders", () => {
  const mm = fakeMatchMedia.install(false);
  const { rerender } = render(<Demo />);
  act(() => mm.set(true));
  rerender(<Demo />);
  expect(document.querySelector("[data-slot=sheet-content]")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
});

test("the next opening reads the breakpoint afresh", () => {
  const mm = fakeMatchMedia.install(true);
  const { rerender } = render(<Demo />);
  expect(document.querySelector("[data-slot=drawer-content]")).toBeInTheDocument();
  rerender(<Demo open={false} />);
  act(() => mm.set(false));
  rerender(<Demo open={false} />);
  rerender(<Demo open />);
  expect(document.querySelector("[data-slot=sheet-content]")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
});
