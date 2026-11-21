import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

test("passes extra props through to the svg", () => {
  const { container } = render(<Spinner data-icon="inline-start" />);
  const svg = container.querySelector("svg");
  expect(svg).toHaveAttribute("data-icon", "inline-start");
  expect(svg).toHaveAttribute("aria-hidden", "true");
});

test("the button variant leaves sizing to the Button; the text variant sets its own", () => {
  const { container } = render(
    <>
      <Button size="sm">
        <Spinner />
      </Button>
      <Spinner size="text" />
    </>,
  );
  const [inButton, text] = Array.from(container.querySelectorAll("svg"));
  expect(inButton?.getAttribute("class")).not.toMatch(/size-/);
  expect(text).toHaveClass("size-3.5");
});
