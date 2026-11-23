import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Spinner } from "@/components/ui/spinner";

test("passes extra props through to the svg", () => {
  const { container } = render(<Spinner data-icon="inline-start" />);
  const svg = container.querySelector("svg");
  expect(svg).toHaveAttribute("data-icon", "inline-start");
  expect(svg).toHaveAttribute("aria-hidden", "true");
});
