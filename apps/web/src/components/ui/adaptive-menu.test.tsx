import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { endAnimation } from "@/test/end-animation";
import { fakeMatchMedia } from "@/test/fake-match-media";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuLabel,
  AdaptiveMenuSeparator,
  AdaptiveMenuShortcut,
  AdaptiveMenuTrigger,
} from "./adaptive-menu";

const release = vi.hoisted(() => ({ armed: false }));
vi.mock("@/hooks/use-long-press", () => ({
  consumeLongPressRelease: () => {
    const was = release.armed;
    release.armed = false;
    return was;
  },
}));

const original = window.matchMedia;
let mm: ReturnType<typeof fakeMatchMedia.install>;
beforeEach(() => {
  release.armed = false;
});
afterEach(() => {
  window.matchMedia = original;
});

const phone = () => {
  mm = fakeMatchMedia.install(true);
};
const desktop = () => {
  mm = fakeMatchMedia.install(false);
};

function Menu({
  onEdit = () => {},
  onDelete = () => {},
  onOpenChange,
  anchor,
}: {
  onEdit?: (e: Event) => void;
  onDelete?: (e: Event) => void;
  onOpenChange?: (open: boolean) => void;
  anchor?: { x: number; y: number };
}) {
  return (
    <AdaptiveMenu title="Priya Nair" anchor={anchor} onOpenChange={onOpenChange}>
      <AdaptiveMenuTrigger asChild>
        <button type="button">More</button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent>
        <AdaptiveMenuLabel>Agent</AdaptiveMenuLabel>
        <AdaptiveMenuItem opensOverlay onSelect={onEdit}>
          Edit
          <AdaptiveMenuShortcut>E</AdaptiveMenuShortcut>
        </AdaptiveMenuItem>
        <AdaptiveMenuItem onSelect={() => {}}>Copy link</AdaptiveMenuItem>
        <AdaptiveMenuItem variant="destructive" onSelect={onDelete}>
          Terminate…
        </AdaptiveMenuItem>
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}

// A modal dropdown hides the page behind it from the accessibility tree.
const trigger = () => screen.getByRole("button", { name: "More", hidden: true });
const mouseDown = (el: Element) => fireEvent.pointerDown(el, { button: 0, pointerType: "mouse" });
const touchTap = (el: Element) => {
  fireEvent.pointerDown(el, { button: 0, pointerType: "touch" });
  fireEvent.click(el);
};

test("at 48rem and up it is a dropdown menu", () => {
  desktop();
  render(<Menu />);
  mouseDown(trigger());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /Edit/ })).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
  expect(trigger()).toHaveAttribute("aria-expanded", "true");
});

test("below 48rem it is a drawer with the title visible and Cancel last", () => {
  phone();
  render(<Menu />);
  touchTap(trigger());
  const drawer = screen.getByRole("dialog");
  expect(drawer).toHaveAttribute("data-slot", "drawer-content");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByText("Priya Nair")).toBeVisible();
  const buttons = [...drawer.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Edit", "Copy link", "Terminate…", "Cancel"]);
  for (const b of buttons) expect(b).toHaveClass("min-h-11");
  expect(screen.getByRole("button", { name: "Terminate…" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  // Shortcuts are hidden on phones.
  expect(screen.queryByText("E")).toBeNull();
  expect(trigger()).toHaveAttribute("aria-expanded", "true");
});

test("Cancel closes the drawer", () => {
  phone();
  const onOpenChange = vi.fn();
  render(<Menu onOpenChange={onOpenChange} />);
  touchTap(trigger());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute("data-state", "closed");
});

test("a touch pointerdown on the trigger does not open; the click that follows does", () => {
  desktop();
  render(<Menu />);
  fireEvent.pointerDown(trigger(), { button: 0, pointerType: "touch" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(trigger());
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("a pen pointerdown does not open either", () => {
  phone();
  render(<Menu />);
  fireEvent.pointerDown(trigger(), { button: 0, pointerType: "pen" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a mouse pointerdown opens, and the click that follows does not toggle it shut", () => {
  desktop();
  render(<Menu />);
  mouseDown(trigger());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.click(trigger());
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("a mouse pointerdown opens the drawer on a phone", () => {
  phone();
  render(<Menu />);
  mouseDown(trigger());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("an item that opens an overlay stamps the drawer instant and selects in the same tick the close starts", () => {
  phone();
  const log: string[] = [];
  const onEdit = vi.fn(() => {
    log.push("select");
  });
  render(<Menu onEdit={onEdit} onOpenChange={(o) => log.push(`open:${o}`)} />);
  touchTap(trigger());
  log.length = 0;
  const content = document.querySelector("[data-slot=drawer-content]");
  const overlay = document.querySelector("[data-slot=drawer-overlay]");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(log).toEqual(["select", "open:false"]);
  expect(content).toHaveAttribute("data-instant");
  expect(overlay).toHaveAttribute("data-instant");
});

test("an item that opens nothing closes the drawer normally", () => {
  phone();
  const onOpenChange = vi.fn();
  render(<Menu onOpenChange={onOpenChange} />);
  touchTap(trigger());
  const content = document.querySelector("[data-slot=drawer-content]");
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(content).not.toHaveAttribute("data-instant");
});

test("onSelect that prevents default keeps the drawer open and unstamped", () => {
  phone();
  const onOpenChange = vi.fn();
  render(<Menu onOpenChange={onOpenChange} onEdit={(e) => e.preventDefault()} />);
  touchTap(trigger());
  onOpenChange.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(document.querySelector("[data-slot=drawer-content]")).not.toHaveAttribute("data-instant");
});

test("on desktop an item that opens an overlay selects and closes the dropdown", () => {
  desktop();
  const log: string[] = [];
  render(<Menu onEdit={() => log.push("select")} onOpenChange={(o) => log.push(`open:${o}`)} />);
  mouseDown(trigger());
  log.length = 0;
  const content = screen.getByRole("menu");
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit/ }));
  expect(log).toEqual(["select", "open:false"]);
  expect(content).toHaveAttribute("data-instant");
});

test("flipping the viewport while open keeps the surface it opened on", () => {
  desktop();
  render(<Menu />);
  mouseDown(trigger());
  act(() => mm.set(true));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
});

test("flipping the viewport while the drawer is open keeps the drawer", () => {
  phone();
  render(<Menu />);
  touchTap(trigger());
  act(() => mm.set(false));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the next opening follows the viewport", () => {
  desktop();
  render(<Menu />);
  mouseDown(trigger());
  act(() => mm.set(true));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  touchTap(trigger());
  expect(screen.getByRole("dialog")).toHaveAttribute("data-slot", "drawer-content");
});

test("a destructive last item is separated from Cancel by a rule", () => {
  phone();
  render(<Menu />);
  touchTap(trigger());
  const destructive = screen.getByRole("button", { name: "Terminate…" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  // The items' list ends with the destructive item; the rule and Cancel follow it.
  expect(destructive.nextElementSibling).toBeNull();
  const rule = cancel.previousElementSibling;
  expect(rule).toHaveAttribute("data-slot", "adaptive-menu-cancel-rule");
  expect(rule?.previousElementSibling).toContainElement(destructive);
});

test("a touch pointerdown on a phone does not open the drawer; the click does", () => {
  phone();
  render(<Menu />);
  fireEvent.pointerDown(trigger(), { button: 0, pointerType: "touch" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("on a phone the trigger announces a dialog and controls nothing absent", () => {
  phone();
  render(<Menu />);
  expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
  touchTap(trigger());
  expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
  expect(trigger()).not.toHaveAttribute("aria-controls");
});

test("on a phone a focus handoff in onCloseAutoFocus wins over the trigger", async () => {
  phone();
  function Handoff() {
    return (
      <>
        <input aria-label="Next overlay" />
        <AdaptiveMenu title="Priya Nair">
          <AdaptiveMenuTrigger asChild>
            <button type="button">More</button>
          </AdaptiveMenuTrigger>
          <AdaptiveMenuContent
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              document.querySelector<HTMLInputElement>("[aria-label='Next overlay']")?.focus();
            }}
          >
            <AdaptiveMenuItem opensOverlay onSelect={() => {}}>
              Edit
            </AdaptiveMenuItem>
          </AdaptiveMenuContent>
        </AdaptiveMenu>
      </>
    );
  }
  render(<Handoff />);
  trigger().focus();
  touchTap(trigger());
  const content = document.querySelector("[data-slot=drawer-content]") as HTMLElement;
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  // Vaul animates the drawer out with a keyframe jsdom never runs: end it, so the content unmounts.
  const end = new Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: getComputedStyle(content).animationName });
  act(() => {
    content.dispatchEvent(end);
  });
  const next = document.querySelector("[aria-label='Next overlay']");
  await waitFor(() => expect(document.activeElement).toBe(next));
});

test("on a phone a consumer's separator is a rule too", () => {
  phone();
  render(
    <AdaptiveMenu title="Priya Nair" open>
      <AdaptiveMenuTrigger asChild>
        <button type="button">More</button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent>
        <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
        <AdaptiveMenuSeparator />
        <AdaptiveMenuItem onSelect={() => {}}>Archive</AdaptiveMenuItem>
      </AdaptiveMenuContent>
    </AdaptiveMenu>,
  );
  const archive = screen.getByRole("button", { name: "Archive" });
  expect(archive.previousElementSibling).toHaveAttribute("data-slot", "adaptive-menu-separator");
});

test("on desktop the first pointerup after a long-press is ignored, the next selects", () => {
  desktop();
  const onEdit = vi.fn();
  render(<Menu onEdit={onEdit} />);
  mouseDown(trigger());
  release.armed = true;
  const item = screen.getByRole("menuitem", { name: /Edit/ });
  fireEvent.pointerUp(item, { pointerType: "touch" });
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerUp(item, { pointerType: "touch" });
  expect(onEdit).toHaveBeenCalledTimes(1);
});

test("with an anchor, the dropdown hangs from a stand-in at that point", () => {
  desktop();
  function Anchored() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Long-press
        </button>
        <AdaptiveMenu title="Priya Nair" open={open} onOpenChange={setOpen} anchor={{ x: 40, y: 120 }}>
          <AdaptiveMenuTrigger asChild>
            <button type="button">More</button>
          </AdaptiveMenuTrigger>
          <AdaptiveMenuContent>
            <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
          </AdaptiveMenuContent>
        </AdaptiveMenu>
      </>
    );
  }
  render(<Anchored />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  const standIn = document.querySelector<HTMLElement>("[data-menu-stand-in]");
  expect(standIn).not.toBeNull();
  expect(standIn?.style.left).toBe("40px");
  expect(standIn?.style.top).toBe("120px");
  expect(screen.getByRole("menu", { name: "Priya Nair" })).not.toHaveAttribute("aria-labelledby");
  expect(trigger()).toHaveAttribute("aria-expanded", "true");
});

function AnchoredButton({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Long-press
      </button>
      <AdaptiveMenu
        title="Priya Nair"
        open={open}
        onOpenChange={(o) => {
          onOpenChange?.(o);
          setOpen(o);
        }}
        anchor={{ x: 40, y: 120 }}
      >
        <AdaptiveMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Actions for Priya Nair">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </AdaptiveMenuTrigger>
        <AdaptiveMenuContent>
          <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
        </AdaptiveMenuContent>
      </AdaptiveMenu>
    </>
  );
}

test("anchored, a Button trigger is still a button", () => {
  desktop();
  render(<AnchoredButton />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  const more = screen.getByRole("button", { name: "Actions for Priya Nair", hidden: true });
  expect(more.tagName).toBe("BUTTON");
  expect(more).not.toHaveAttribute("asChild");
  expect(more).toHaveAttribute("aria-expanded", "true");
});

test("anchored, a mouse press on the trigger while open reports the close once", async () => {
  desktop();
  const onOpenChange = vi.fn();
  render(<AnchoredButton onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  const more = screen.getByRole("button", { name: "Actions for Priya Nair", hidden: true });
  // Radix registers its outside-pointerdown listener a tick after the menu opens.
  await act(() => new Promise((r) => setTimeout(r, 0)));
  mouseDown(more);
  expect(onOpenChange.mock.calls.filter(([o]) => o === false)).toHaveLength(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("controlled: open and onOpenChange drive it", () => {
  phone();
  const onOpenChange = vi.fn();
  const { rerender } = render(
    <AdaptiveMenu title="S-12" open={false} onOpenChange={onOpenChange}>
      <AdaptiveMenuTrigger asChild>
        <button type="button">More</button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent>
        <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
      </AdaptiveMenuContent>
    </AdaptiveMenu>,
  );
  touchTap(trigger());
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(
    <AdaptiveMenu title="S-12" open onOpenChange={onOpenChange}>
      <AdaptiveMenuTrigger asChild>
        <button type="button">More</button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent>
        <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
      </AdaptiveMenuContent>
    </AdaptiveMenu>,
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("S-12")).toBeVisible();
});

test("on a phone, closing the drawer with no handoff returns focus to the trigger", async () => {
  phone();
  render(<Menu />);
  trigger().focus();
  touchTap(trigger());
  const content = document.querySelector("[data-slot=drawer-content]") as HTMLElement;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const end = new Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: getComputedStyle(content).animationName });
  act(() => {
    content.dispatchEvent(end);
  });
  await waitFor(() => expect(document.querySelector("[data-slot=drawer-content]")).toBeNull());
  await waitFor(() => expect(trigger()).toHaveFocus());
});

/** A long-press sets the anchor; the menu's own opening (the trigger) drops it, as RowMenu and AgentMenu do. */
function LatchedAnchor() {
  const [menu, setMenu] = useState<{ open: boolean; anchor?: { x: number; y: number } }>({ open: false });
  return (
    <>
      <button type="button" onClick={() => setMenu({ open: true, anchor: { x: 40, y: 120 } })}>
        Long-press
      </button>
      <AdaptiveMenu
        title="Priya Nair"
        open={menu.open}
        onOpenChange={(open) => setMenu((m) => (open ? { open } : { ...m, open }))}
        anchor={menu.anchor}
      >
        <AdaptiveMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Actions for Priya Nair">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </AdaptiveMenuTrigger>
        <AdaptiveMenuContent>
          <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
        </AdaptiveMenuContent>
      </AdaptiveMenu>
    </>
  );
}
const more = () => screen.getByRole("button", { name: "Actions for Priya Nair", hidden: true });

test("anchored, closing with no handoff returns focus to the visible trigger, not the stand-in", async () => {
  desktop();
  render(<LatchedAnchor />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(more()).toHaveFocus());
});

test("the visible trigger keeps its element across an anchored then a plain opening", async () => {
  desktop();
  render(<LatchedAnchor />);
  const before = more();
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  expect(document.querySelector("[data-menu-stand-in]")).not.toBeNull();
  expect(more()).toBe(before);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // The anchor stays latched through the close; the trigger's own opening drops it.
  mouseDown(more());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(document.querySelector("[data-menu-stand-in]")).toBeNull();
  expect(more()).toBe(before);
  expect(more()).toHaveAttribute("aria-expanded", "true");
  // Radix's own focus return finds the visible trigger again once the stand-in is gone.
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(more()).toHaveFocus());
});

/** A long-pressable row whose ⋯ isn't rendered on this pointer (it can't take focus), as a touch-only row. */
function RowWithHiddenTrigger() {
  const [menu, setMenu] = useState<{ open: boolean; anchor?: { x: number; y: number } }>({ open: false });
  return (
    <div data-longpress-region="">
      <a href="#row">Priya's row</a>
      <button type="button" onClick={() => setMenu({ open: true, anchor: { x: 40, y: 120 } })}>
        Long-press
      </button>
      <AdaptiveMenu
        title="Priya Nair"
        open={menu.open}
        onOpenChange={(open) => setMenu((m) => (open ? { open } : { ...m, open }))}
        anchor={menu.anchor}
      >
        <AdaptiveMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Actions for Priya Nair"
            // jsdom focuses anything; a browser won't focus a ⋯ that is display:none.
            ref={(el) => {
              if (el) el.focus = () => {};
            }}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </AdaptiveMenuTrigger>
        <AdaptiveMenuContent>
          <AdaptiveMenuItem onSelect={() => {}}>Edit</AdaptiveMenuItem>
        </AdaptiveMenuContent>
      </AdaptiveMenu>
    </div>
  );
}
const rowLink = () => screen.getByRole("link", { name: "Priya's row", hidden: true });

test("anchored dropdown: when the ⋯ can't take focus, closing returns it to the pressed row", async () => {
  desktop();
  render(<RowWithHiddenTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(rowLink()).toHaveFocus());
});

test("drawer: when the ⋯ can't take focus, closing returns it to the pressed row", async () => {
  phone();
  render(<RowWithHiddenTrigger />);
  fireEvent.click(screen.getByRole("button", { name: "Long-press" }));
  const content = document.querySelector("[data-slot=drawer-content]") as HTMLElement;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  endAnimation(content);
  await waitFor(() => expect(document.querySelector("[data-slot=drawer-content]")).toBeNull());
  await waitFor(() => expect(rowLink()).toHaveFocus());
});
