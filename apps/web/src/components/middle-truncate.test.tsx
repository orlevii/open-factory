import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { MiddleTruncate } from "./middle-truncate";

test("the head shrinks first; the last segment is capped at the line and truncates only then", () => {
  const { container } = render(
    <MiddleTruncate text="/home/templates/platform-reliability-incident-commanders" />,
  );
  const [head, tail] = container.querySelectorAll("[aria-hidden=true]");
  expect(head).toHaveTextContent("/home/templates");
  expect(head).toHaveClass("truncate");
  expect(tail).toHaveTextContent("/platform-reliability-incident-commanders");
  expect(tail).toHaveClass("shrink-0", "max-w-full", "truncate");
});
