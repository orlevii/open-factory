import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { Drawer as Vaul } from "vaul";
import { expect, test, vi } from "vitest";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./drawer";

// Pass-through: the real Vaul Root, with the props our wrapper hands it recorded, so a test can fire
// onRelease (a real drag needs computed transforms jsdom does not have).
const rootProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("vaul", async (importOriginal) => {
  const mod = await importOriginal<typeof import("vaul")>();
  const Root = (props: React.ComponentProps<typeof mod.Drawer.Root>) => {
    rootProps.current = props as Record<string, unknown>;
    return <mod.Drawer.Root {...props} />;
  };
  return { ...mod, Drawer: { ...mod.Drawer, Root } };
});

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

test("the content it focuses shows no focus ring: it is a landing point, not a control", () => {
  // jsdom has no :focus-visible styles; the browser pass checks the drawer opens without the ring.
  open();
  const content = document.querySelector("[data-slot=drawer-content]");
  expect(document.activeElement).toBe(content);
  expect(content).toHaveClass("outline-none");
});

test("reduced motion fades an inner wrapper", () => {
  open();
  const inner = document.querySelector("[data-slot=drawer-inner]");
  expect(inner).toHaveClass("motion-reduce:animate-in", "motion-reduce:fade-in-0");
});

test("bottom drawer caps its column", () => {
  open("bottom");
  expect(document.querySelector("[data-slot=drawer-inner]")).toHaveClass("max-w-lg", "mx-auto");
});

test("left drawer has its own width: --sidebar-width when a consumer sets it, else 16rem", () => {
  open("left");
  const content = document.querySelector("[data-slot=drawer-content]");
  // The portal sits in <body>, outside sidebar-wrapper, so the variable needs a fallback.
  expect(content).toHaveClass("inset-y-0", "left-0", "w-[var(--sidebar-width,16rem)]");
  expect(content).not.toHaveClass("w-(--sidebar-width)");
  expect(document.querySelector("[data-slot=drawer-inner]")).not.toHaveClass("max-w-lg");
});

test("uncontrolled: a drag-close release mark clears when the drawer opens again", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <Drawer onOpenChange={onOpenChange}>
      <Vaul.Trigger>Open</Vaul.Trigger>
      <DrawerContent>
        <DrawerTitle>Title</DrawerTitle>
        <DrawerClose>Close</DrawerClose>
      </DrawerContent>
    </Drawer>,
  );
  await user.click(screen.getByText("Open"));
  const release = rootProps.current?.onRelease as (e: unknown, open: boolean) => void;
  act(() => release(new Event("pointerup"), false));
  expect(document.querySelector("[data-slot=drawer-content]")).toHaveAttribute("data-released");
  await user.click(screen.getByText("Close"));
  await act(() => new Promise((r) => setTimeout(r, 600)));
  await user.click(screen.getByText("Open"));
  expect(document.querySelector("[data-slot=drawer-content]")).not.toHaveAttribute("data-released");
  expect(onOpenChange).toHaveBeenCalledWith(true);
});
