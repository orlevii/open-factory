import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { shouldIgnore } from "@/lib/shortcuts";
import { installInputModality } from "@/lib/input-modality";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle, closeInstantly } from "./sheet";

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

function Triggered() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Demo open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Mirrors overlay-timing.test.tsx: Enter-open stamps, click-open does not, Enter again stamps. */
async function stampedPerOpening(prefix: "sheet" | "drawer") {
  const off = installInputModality();
  try {
    render(<Triggered />);
    const trigger = screen.getByRole("button", { name: "Open" });
    const content = () => document.querySelector(`[data-slot=${prefix}-content]`);
    const overlay = () => document.querySelector(`[data-slot=${prefix}-overlay]`);
    const closed = async () => {
      await userEvent.keyboard("{Escape}");
      // jsdom never finishes Vaul's injected exit keyframes; end them as the browser would.
      // (jsdom has no AnimationEvent, so the name is set on a plain Event.)
      for (const node of [content(), overlay()]) {
        if (!node) continue;
        const end = Object.assign(new Event("animationend", { bubbles: true }), {
          animationName: getComputedStyle(node).animationName,
        });
        act(() => {
          node.dispatchEvent(end);
        });
      }
      await vi.waitFor(() => expect(content()).toBeNull());
    };
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
    expect(overlay()).toHaveAttribute("data-instant");
    await closed();
    await userEvent.click(trigger);
    await vi.waitFor(() => expect(content()).not.toBeNull());
    expect(content()).not.toHaveAttribute("data-instant");
    expect(overlay()).not.toHaveAttribute("data-instant");
    await closed();
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
    expect(overlay()).toHaveAttribute("data-instant");
  } finally {
    off();
  }
}

test("desktop: content and overlay are stamped per opening, not per mount", async () => {
  fakeMatchMedia.install(false);
  await stampedPerOpening("sheet");
});

test("mobile: drawer content and overlay are stamped per opening, not per mount", async () => {
  fakeMatchMedia.install(true);
  await stampedPerOpening("drawer");
});

type PeekProps = Partial<React.ComponentProps<typeof SheetContent>> & { modal?: boolean };
function Peek({ modal = false, onOpenChange, ...content }: PeekProps & { onOpenChange?: (o: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open peek
      </button>
      <button type="button">Outside</button>
      <button type="button" id="row">
        Row
      </button>
      <Sheet
        open={open}
        modal={modal}
        onOpenChange={(o) => {
          onOpenChange?.(o);
          setOpen(o);
        }}
      >
        <SheetContent {...content}>
          <SheetHeader>
            <SheetTitle>Peek</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <input aria-label="inside" />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

test("modal={false}: no overlay, no aria-modal, outside click keeps it open, Esc closes", async () => {
  fakeMatchMedia.install(false);
  render(<Peek />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  const panel = await screen.findByRole("dialog", { name: "Peek" });
  expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
  expect(panel).not.toHaveAttribute("aria-modal", "true");
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  expect(screen.getByRole("dialog", { name: "Peek" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("modal sheets still render the overlay", async () => {
  fakeMatchMedia.install(false);
  render(<Peek modal />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  await screen.findByRole("dialog", { name: "Peek" });
  expect(document.querySelector("[data-slot=sheet-overlay]")).toBeInTheDocument();
});

test.each([
  [false, false],
  [true, true],
])("shortcut layer: sheet modal=%s ignores keys inside it: %s", async (modal, ignored) => {
  fakeMatchMedia.install(false);
  render(<Peek modal={modal} />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  const panel = await screen.findByRole("dialog", { name: "Peek" });
  const e = new KeyboardEvent("keydown", { key: "c", bubbles: true });
  Object.defineProperty(e, "target", { value: panel });
  expect(shouldIgnore(e)).toBe(ignored);
});

test("Esc close is instant (data-instant stamped on the content before closing)", async () => {
  fakeMatchMedia.install(false);
  let stampedAtClose: boolean | undefined;
  render(
    <Peek
      onOpenChange={(o) => {
        if (!o) stampedAtClose = document.querySelector("[data-slot=sheet-content]")?.hasAttribute("data-instant");
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  const panel = await screen.findByRole("dialog", { name: "Peek" });
  expect(panel).not.toHaveAttribute("data-instant");
  await userEvent.keyboard("{Escape}");
  expect(stampedAtClose).toBe(true);
});

test("closeInstantly stamps the content, then closes", () => {
  const el = document.createElement("div");
  const onOpenChange = vi.fn(() => expect(el).toHaveAttribute("data-instant"));
  closeInstantly(el, onOpenChange);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("keepFocus: opening leaves focus where it was; returnFocus decides where focus goes on close", async () => {
  fakeMatchMedia.install(false);
  render(<Peek keepFocus returnFocus={() => document.getElementById("row")} />);
  const trigger = screen.getByRole("button", { name: "Open peek" });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Peek" });
  expect(trigger).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.getElementById("row")).toHaveFocus());
});

test("without keepFocus, opening moves focus into the sheet", async () => {
  fakeMatchMedia.install(false);
  render(<Peek />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  const panel = await screen.findByRole("dialog", { name: "Peek" });
  await vi.waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
});

test("width='panel' and inset='below-header' classes", async () => {
  fakeMatchMedia.install(false);
  render(<Peek width="panel" inset="below-header" />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  const panel = await screen.findByRole("dialog", { name: "Peek" });
  const tokens = panel.className.split(/\s+/);
  expect(tokens).toContain("w-[min(20rem,100%)]");
  expect(tokens).toContain("top-12");
  expect(tokens).toContain("bottom-0");
  expect(tokens).not.toContain("inset-y-0");
  expect(tokens).not.toContain("w-[min(30rem,100%)]");
});

test("below md it is still the modal bottom drawer", async () => {
  fakeMatchMedia.install(true);
  render(<Peek />);
  await userEvent.click(screen.getByRole("button", { name: "Open peek" }));
  await vi.waitFor(() => expect(document.querySelector("[data-slot=drawer-content]")).toBeInTheDocument());
  expect(document.querySelector("[data-slot=drawer-overlay]")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
});
