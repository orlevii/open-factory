import { render, screen } from "@testing-library/react";
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
