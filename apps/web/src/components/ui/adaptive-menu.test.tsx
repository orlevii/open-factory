import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

test("a trailing destructive item is preceded by a separator", () => {
  phone();
  render(<Menu />);
  touchTap(trigger());
  const destructive = screen.getByRole("button", { name: "Terminate…" });
  expect(destructive.previousElementSibling).toHaveAttribute("role", "separator");
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
  expect(screen.getByRole("menu")).toHaveAttribute("aria-labelledby", standIn?.id);
  expect(trigger()).toHaveAttribute("aria-expanded", "true");
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
