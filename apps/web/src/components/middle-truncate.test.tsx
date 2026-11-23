import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MiddleTruncate } from "./middle-truncate";

test("the head shrinks first; the last segment is capped at the line and truncates only then", () => {
  const { container } = render(
    <MiddleTruncate text="/home/templates/platform-reliability-incident-commanders" />,
  );
  const [head, tail] = container.querySelectorAll("[aria-hidden=true]");
  expect(head).toHaveTextContent("/home/templates");
  expect(tail).toHaveTextContent("/platform-reliability-incident-commanders");
});

test("a handle (no '/') truncates in the middle: its head and its tail both stay", () => {
  const { container } = render(<MiddleTruncate text="@marketing-team" />);
  const [head, tail] = container.querySelectorAll("[aria-hidden=true]");
  expect(head).toHaveTextContent("@marketi");
  expect(tail).toHaveTextContent("ng-team");
  expect(container.querySelector(".sr-only")).toHaveTextContent("@marketing-team");
});

test("a file name that must keep its extension cuts its last segment from the start", () => {
  const { container } = render(
    <MiddleTruncate keepEnd text="/work/src/features/session/a-very-long-component-name.tsx" />,
  );
  const tail = container.querySelectorAll("[aria-hidden=true]")[1] as HTMLElement;
  expect(tail).toHaveAttribute("dir", "rtl");
  expect(tail.firstElementChild).toHaveAttribute("dir", "ltr");
  expect(tail).toHaveTextContent("/a-very-long-component-name.tsx");
});

test("headMin: a name that fits renders whole, with no gap between its parts", () => {
  const { container } = render(<MiddleTruncate keepEnd headMin text="notes.md" />);
  const parts = container.querySelectorAll("[aria-hidden=true]");
  expect(parts).toHaveLength(1);
  expect(parts[0]).toHaveTextContent("notes.md");
});

test("headMin: once the name overflows it splits, keeping a few characters of the head", () => {
  // Every part reports more content than room: the whole name doesn't fit.
  const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  const { container } = render(
    <MiddleTruncate
      keepEnd
      headMin
      text="my-very-long-design-review-notes-for-the-chip-final-v2.md"
    />,
  );
  expect(container.querySelectorAll("[aria-hidden=true]")).toHaveLength(2);
  expect(container.querySelector(".sr-only")).toHaveTextContent(
    "my-very-long-design-review-notes-for-the-chip-final-v2.md",
  );
  sw.mockRestore();
  cw.mockRestore();
});
