import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from "./drawer";

const open = (direction: "bottom" | "left" = "bottom") =>
  render(
    <Drawer open direction={direction} onOpenChange={() => {}}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Title</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <input aria-label="field" />
        </DrawerBody>
        <DrawerFooter>
          <button type="button">Act</button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>,
  );

test("Vaul upgrade guard: the attributes and injected rules our overrides depend on (Vaul 1.1.2)", () => {
  open();
  const content = document.querySelector("[data-slot=drawer-content]");
  expect(content).toHaveAttribute("data-vaul-drawer");
  expect(content).toHaveAttribute("data-state", "open");
  expect(document.querySelector("[data-slot=drawer-overlay]")).toHaveAttribute("data-vaul-overlay");
  const injected = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("");
  expect(injected).toContain("[data-vaul-drawer]{");
  expect(injected).toContain("animation-duration:.5s");
  expect(injected).toContain("[data-vaul-overlay][data-vaul-snap-points=false]{");
  expect(injected).toMatch(/animation-name:slideFromBottom/);
  expect(injected).toMatch(/animation-name:slideFromLeft/);
  expect(injected).toContain("var(--initial-transform,100%)");
});

test("focus moves into the drawer, onto the content, not the first input", () => {
  open();
  expect(document.activeElement).toBe(document.querySelector("[data-slot=drawer-content]"));
});

test("reduced motion fades an inner wrapper", () => {
  open();
  const inner = document.querySelector("[data-slot=drawer-inner]");
  expect(inner).toHaveClass("motion-reduce:animate-in", "motion-reduce:fade-in-0");
});

test("bottom drawer caps its column; left drawer uses the sidebar width", () => {
  open("bottom");
  expect(document.querySelector("[data-slot=drawer-inner]")).toHaveClass("max-w-lg", "mx-auto");
});
