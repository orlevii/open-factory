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

const PLATE = /(^|\s)(disabled|aria-disabled:not-aria-busy):(bg-card|border-border)(\s|$)/;

describe("Button disabled style", () => {
  // Every variant: muted text, no opacity fade, no press scale, not-allowed cursor; plus its own plate rules.
  const variants: [Variant, { has: string[]; noPlate?: true; notBusyTint?: true }][] = [
    [
      "default",
      {
        has: [
          "disabled:bg-card",
          "disabled:border-border",
          "aria-disabled:not-aria-busy:bg-card",
          "aria-disabled:not-aria-busy:border-border",
          "aria-disabled:not-aria-busy:hover:bg-card",
        ],
      },
    ],
    [
      "outline",
      {
        has: [
          "bg-card",
          "border-border",
          "disabled:border-border",
          "aria-disabled:not-aria-busy:hover:bg-card",
        ],
      },
    ],
    [
      "ghost",
      {
        has: [
          "disabled:bg-transparent",
          "aria-disabled:not-aria-busy:bg-transparent",
          "aria-disabled:not-aria-busy:hover:bg-transparent",
          "aria-disabled:not-aria-busy:hover:text-muted-foreground",
        ],
        noPlate: true,
      },
    ],
    ["link", { has: ["aria-disabled:not-aria-busy:hover:no-underline"], noPlate: true }],
    [
      "destructive",
      {
        // A disabled one drops its crimson tint for the primary's plate; a busy one keeps it.
        has: ["disabled:bg-card", "disabled:border-border", "aria-disabled:not-aria-busy:bg-card"],
        notBusyTint: true,
      },
    ],
  ];

  test.each(variants)("%s: muted, no fade, no press scale, its own plate rules", (variant, rule) => {
    for (const el of renderBoth(variant)) {
      expect(el).toHaveClass(
        "disabled:text-muted-foreground",
        "aria-disabled:not-aria-busy:text-muted-foreground",
        "aria-disabled:not-aria-busy:cursor-not-allowed",
        "aria-disabled:active:scale-100",
        ...rule.has,
      );
      expect(el.className).not.toContain("opacity-50");
      if (rule.noPlate) expect(el.className).not.toMatch(PLATE);
      if (rule.notBusyTint) expect(el.className).not.toMatch(/(^|\s)aria-disabled:bg-card/);
    }
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
      // min-w: a header action whose label is sr-only on phones is its icon alone.
      expect(el, size).toHaveClass("pointer-coarse:h-10", "pointer-coarse:min-w-10");
      expect(el, size).not.toHaveClass("hit-40");
    }
  });

  test("a button in a form has no expander: it grows to 40px with real padding", () => {
    for (const size of ["sm", "xs", "default"] as const) {
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
