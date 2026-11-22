import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useRef } from "react";
import { expect, test, vi } from "vitest";
import { CaretMenu, type CaretMenuHandle } from "./caret-menu";
import type { CompletionItem } from "./composer";

const ITEMS: CompletionItem[] = [
  { id: "dev", label: "Dev", detail: "@dev", group: "agents" },
  { id: "dana", label: "Dana", detail: "@dana", group: "humans" },
  { id: "humans", label: "Humans", detail: "@humans", group: "humans" },
];
const ANCHOR = { x: 10, y: 20 };

function Harness({
  menu,
  onPick,
  onClose,
  items = ITEMS,
}: {
  menu: React.Ref<CaretMenuHandle>;
  onPick: (i: CompletionItem) => void;
  onClose: () => void;
  items?: CompletionItem[];
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="relative">
      {/* Focused as it mounts, before the menu opens: the menu must leave it there. */}
      <textarea
        ref={(el) => {
          input.current = el;
          el?.focus();
        }}
        aria-label="Box"
      />
      <CaretMenu
        ref={menu}
        input={input}
        label="Handles"
        anchor={ANCHOR}
        items={items}
        onPick={onPick}
        onClose={onClose}
      />
    </div>
  );
}

function setup(items?: CompletionItem[]) {
  const menu = createRef<CaretMenuHandle>();
  const onPick = vi.fn();
  const onClose = vi.fn();
  const r = render(<Harness menu={menu} onPick={onPick} onClose={onClose} items={items} />);
  return { menu, onPick, onClose, box: screen.getByRole("textbox", { name: "Box" }), ...r };
}

const selected = () =>
  screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

test("a listbox of the items opens upward, the first highlighted; focus stays in the box", () => {
  const { box } = setup();
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    expect.stringContaining("Dev"),
    expect.stringContaining("Dana"),
    expect.stringContaining("Humans"),
  ]);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  expect(selected()).toHaveTextContent("Dev");
  expect(document.activeElement).toBe(box);
  expect(box.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  expect(box.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  const content = document.querySelector("[data-caret-menu]");
  expect(content).toHaveAttribute("data-side", "top");
  // Keyboard-opened: no animation, whatever the last input was.
  expect(content).toHaveAttribute("data-instant");
});

test("move walks the highlight (wrapping) and aria-activedescendant follows", () => {
  const { menu, box } = setup();
  act(() => menu.current?.move(1));
  expect(selected()).toHaveTextContent("Dana");
  expect(box.getAttribute("aria-activedescendant")).toBe(selected()?.id);
  act(() => menu.current?.move(-1));
  act(() => menu.current?.move(-1));
  expect(selected()).toHaveTextContent("Humans");
});

test("accept picks the highlighted item", () => {
  const { menu, onPick } = setup();
  act(() => menu.current?.move(1));
  act(() => {
    expect(menu.current?.accept()).toBe(true);
  });
  expect(onPick).toHaveBeenCalledWith(ITEMS[1]);
});

test("a new list highlights its first item again", () => {
  const { menu, rerender, onPick, onClose } = setup();
  act(() => menu.current?.move(2));
  const next = ITEMS.slice(1);
  rerender(<Harness menu={menu} onPick={onPick} onClose={onClose} items={next} />);
  expect(selected()).toHaveTextContent("Dana");
});

test("a click picks the item and focus stays in the box", async () => {
  const { onPick, box } = setup();
  await userEvent.click(screen.getByRole("option", { name: /Dana/ }));
  expect(onPick).toHaveBeenCalledWith(ITEMS[1]);
  expect(document.activeElement).toBe(box);
});

test("Esc closes", () => {
  const { onClose, box } = setup();
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("leaving removes the box's combobox attributes", () => {
  const { box, unmount } = setup();
  expect(box).toHaveAttribute("aria-activedescendant");
  unmount();
  expect(box).not.toHaveAttribute("aria-activedescendant");
});
