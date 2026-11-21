import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Button } from "./button";

describe("Button disabled style", () => {
  test("disabled and aria-disabled share one look, never opacity", () => {
    render(
      <>
        <Button disabled>a</Button>
        <Button aria-disabled="true">b</Button>
      </>,
    );
    for (const name of ["a", "b"]) {
      const el = screen.getByRole("button", { name });
      expect(el).toHaveClass("disabled:bg-card", "disabled:border-border", "disabled:text-muted-foreground");
      expect(el).toHaveClass("aria-disabled:not-aria-busy:bg-card");
      expect(el.className).not.toContain("opacity-50");
    }
  });

  test("the secondary variant is gone", () => {
    // @ts-expect-error secondary was removed
    render(<Button variant="secondary">x</Button>);
  });
});
