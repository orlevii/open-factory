import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { InlineOutcome } from "@/components/inline-outcome";

test("success renders inside the status region, error inside the alert region", () => {
  const { rerender } = render(<InlineOutcome tone="success">Saved.</InlineOutcome>);
  expect(screen.getByRole("status")).toHaveTextContent("Saved.");
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  rerender(<InlineOutcome tone="error">Could not save.</InlineOutcome>);
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save.");
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("Undo calls back and focusOnMount focuses it", async () => {
  const undo = vi.fn();
  render(
    <InlineOutcome tone="success" undo={undo} focusOnMount>
      Archived.
    </InlineOutcome>,
  );
  const btn = screen.getByRole("button", { name: "Undo" });
  expect(btn).toHaveFocus();
  await userEvent.click(btn);
  expect(undo).toHaveBeenCalled();
});

test("focusOnMount without undo focuses the line", () => {
  render(
    <InlineOutcome tone="error" focusOnMount>
      Nope.
    </InlineOutcome>,
  );
  expect(screen.getByText("Nope.").closest("[tabindex]")).toHaveFocus();
});

test("error text appears in an already-mounted alert region", () => {
  const { rerender } = render(<InlineOutcome tone="success">Saved.</InlineOutcome>);
  const alert = screen.getByRole("alert");
  rerender(<InlineOutcome tone="error">Could not save.</InlineOutcome>);
  expect(screen.getByRole("alert")).toBe(alert);
  expect(alert).toHaveTextContent("Could not save.");
});

test("with no tone both regions are mounted and empty; pending goes in the status region", () => {
  const { rerender } = render(<InlineOutcome />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  rerender(<InlineOutcome tone="pending">Saving…</InlineOutcome>);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Saving…");
});

test("a new focusKey moves focus to the line; the first render doesn't", () => {
  const { rerender } = render(
    <InlineOutcome tone="pending" focusKey={1}>
      Restoring…
    </InlineOutcome>,
  );
  expect(document.body).toHaveFocus();
  rerender(
    <InlineOutcome tone="success" focusKey={2}>
      Restored.
    </InlineOutcome>,
  );
  expect(screen.getByText("Restored.").closest("[tabindex]")).toHaveFocus();
});
