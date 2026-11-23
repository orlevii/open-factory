import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FieldNote, noteDescribedBy } from "@/components/field-note";

test("both layers stay mounted; only the visible one is shown", () => {
  const { container, rerender } = render(<FieldNote id="f" help="Task keys, like T-41." />);
  const help = container.querySelector("#f-help")!;
  const error = container.querySelector("#f-error")!;
  expect(help).toHaveAttribute("data-shown");
  expect(error).not.toHaveAttribute("data-shown");
  rerender(<FieldNote id="f" help="Task keys, like T-41." error="Use task keys, like T-41." />);
  expect(container.querySelector("#f-help")).not.toHaveAttribute("data-shown");
  expect(container.querySelector("#f-error")).toHaveAttribute("data-shown");
  expect(screen.getByText("Use task keys, like T-41.")).toBeInTheDocument();
});

test("the last error text stays after a fix, hidden", () => {
  const { container, rerender } = render(<FieldNote id="f" error="Enter a title." />);
  rerender(<FieldNote id="f" />);
  const error = container.querySelector("#f-error")!;
  expect(error).toHaveTextContent("Enter a title.");
  expect(error).not.toHaveAttribute("data-shown");
});

test("warning uses the error layer without crimson", () => {
  const { container } = render(<FieldNote id="f" warning="Couldn't reach Claude. Try again." />);
  const layer = container.querySelector("#f-error")!;
  expect(layer).toHaveAttribute("data-shown");
  expect(layer).toHaveAttribute("data-tone", "warning");
});

test("backticks render as code", () => {
  render(<FieldNote id="f" help="Create one with `claude setup-token`." />);
  expect(screen.getByText("claude setup-token").tagName).toBe("CODE");
});

test("noteDescribedBy names only the visible note", () => {
  expect(noteDescribedBy("f", {})).toBeUndefined();
  expect(noteDescribedBy("f", { help: "h" })).toBe("f-help");
  expect(noteDescribedBy("f", { help: "h", error: "e" })).toBe("f-error");
  expect(noteDescribedBy("f", { warning: "w" })).toBe("f-error");
});
