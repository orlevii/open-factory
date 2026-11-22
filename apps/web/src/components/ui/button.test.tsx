import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, test } from "vitest";
import { Button } from "./button";

type Variant = "default" | "outline" | "ghost" | "destructive" | "link";

function renderBoth(variant: Variant): HTMLElement[] {
  render(
    <>
      <Button variant={variant} disabled>
        a
      </Button>
      <Button variant={variant} aria-disabled="true">
        b
      </Button>
    </>,
  );
  return [screen.getByRole("button", { name: "a" }), screen.getByRole("button", { name: "b" })];
}

describe("Button disabled style", () => {
  test("every variant: muted text, no opacity fade, no press scale, not-allowed cursor", () => {
    for (const variant of ["default", "outline", "ghost", "destructive", "link"] as const) {
      for (const el of renderBoth(variant)) {
        expect(el).toHaveClass(
          "disabled:text-muted-foreground",
          "aria-disabled:not-aria-busy:text-muted-foreground",
          "aria-disabled:not-aria-busy:cursor-not-allowed",
          "aria-disabled:active:scale-100",
        );
        expect(el.className).not.toContain("opacity-50");
      }
      document.body.innerHTML = "";
    }
  });

  test("a disabled primary keeps the plate with a rule border", () => {
    for (const el of renderBoth("default")) {
      expect(el).toHaveClass(
        "disabled:bg-card",
        "disabled:border-border",
        "aria-disabled:not-aria-busy:bg-card",
        "aria-disabled:not-aria-busy:border-border",
        "aria-disabled:not-aria-busy:hover:bg-card",
      );
    }
  });

  test("a disabled outline keeps its plate and its border at rule colour, no hover fill", () => {
    for (const el of renderBoth("outline")) {
      expect(el).toHaveClass("bg-card", "border-border", "disabled:border-border", "aria-disabled:not-aria-busy:hover:bg-card");
    }
  });

  test("a disabled ghost stays borderless: no plate, no border", () => {
    for (const el of renderBoth("ghost")) {
      expect(el.className).not.toMatch(/(^|\s)(disabled|aria-disabled:not-aria-busy):(bg-card|border-border)(\s|$)/);
      expect(el).toHaveClass(
        "disabled:bg-transparent",
        "aria-disabled:not-aria-busy:bg-transparent",
        "aria-disabled:not-aria-busy:hover:bg-transparent",
        "aria-disabled:not-aria-busy:hover:text-muted-foreground",
      );
    }
  });

  test("a disabled link gains no plate or border and loses its hover underline", () => {
    for (const el of renderBoth("link")) {
      expect(el.className).not.toMatch(/(^|\s)(disabled|aria-disabled:not-aria-busy):(bg-card|border-border)(\s|$)/);
      expect(el).toHaveClass("aria-disabled:not-aria-busy:hover:no-underline");
    }
  });

  test("a disabled destructive drops its crimson tint for the primary's plate; a busy one keeps it", () => {
    for (const el of renderBoth("destructive")) {
      expect(el).toHaveClass("disabled:bg-card", "disabled:border-border", "aria-disabled:not-aria-busy:bg-card");
      expect(el.className).not.toMatch(/(^|\s)aria-disabled:bg-card/);
    }
  });

  test("the secondary variant is gone", () => {
    // @ts-expect-error secondary was removed
    render(<Button variant="secondary">x</Button>);
  });
});

describe("Button hit areas on coarse pointers (U4 §11.3)", () => {
  const button = (props: ComponentProps<typeof Button>) => {
    render(<Button {...props}>x</Button>);
    const el = screen.getByRole("button", { name: "x" });
    document.body.innerHTML = "";
    return el;
  };

  test("icon sizes and small text buttons take the 40px expander and are its containing block", () => {
    for (const size of ["icon", "icon-sm", "icon-xs", "icon-lg", "xs", "sm"] as const)
      expect(button({ size }), size).toHaveClass("relative", "hit-40");
  });

  test("default and lg text buttons grow to 40px for real, with no expander", () => {
    for (const size of ["default", "lg"] as const) {
      const el = button({ size });
      expect(el, size).toHaveClass("pointer-coarse:h-10");
      expect(el, size).not.toHaveClass("hit-40");
    }
  });

  test("a button in a form has no expander: it grows to 40px with real padding", () => {
    for (const size of ["sm", "xs", "icon-sm", "default"] as const) {
      const el = button({ size, inForm: true });
      expect(el, size).not.toHaveClass("hit-40");
      expect(el, size).toHaveClass("pointer-coarse:min-h-10", "pointer-coarse:px-3");
    }
    expect(button({ size: "sm" })).not.toHaveClass("pointer-coarse:min-h-10");
  });

  test("a positioned caller keeps its position (the expander anchors to it)", () => {
    const el = button({ size: "icon-xs", className: "absolute top-1 right-0" });
    expect(el).toHaveClass("absolute", "hit-40");
    expect(el).not.toHaveClass("relative");
  });
});
