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

test("a handle (no '/') truncates in the middle: its head and its tail both stay", () => {
  const { container } = render(<MiddleTruncate text="@marketing-team" />);
  const [head, tail] = container.querySelectorAll("[aria-hidden=true]");
  expect(head).toHaveTextContent("@marketi");
  expect(head).toHaveClass("truncate");
  expect(tail).toHaveTextContent("ng-team");
  expect(tail).toHaveClass("shrink-0");
  expect(container.querySelector(".sr-only")).toHaveTextContent("@marketing-team");
});

test("a file name that must keep its extension cuts its last segment from the start", () => {
  const { container } = render(
    <MiddleTruncate keepEnd text="/work/src/features/session/a-very-long-component-name.tsx" />,
  );
  const tail = container.querySelectorAll("[aria-hidden=true]")[1] as HTMLElement;
  expect(tail).toHaveAttribute("dir", "rtl");
  expect(tail).toHaveClass("shrink-0", "max-w-full", "truncate");
  expect(tail.firstElementChild).toHaveAttribute("dir", "ltr");
  expect(tail).toHaveTextContent("/a-very-long-component-name.tsx");
});
