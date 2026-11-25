import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { NO_OUTCOME } from "@/components/forms/form-outcome";
import { FormFrame } from "./form-frame";

function Sheet(p: {
  onSubmit(): void;
  submitDisabled?: boolean;
  pending?: boolean;
  notice?: string;
}) {
  return (
    <FormFrame
      frame="sheet"
      label="Thing"
      onSubmit={p.onSubmit}
      onCancel={() => {}}
      submitLabel="Go"
      pendingLabel="Going…"
      pending={p.pending ?? false}
      submitDisabled={p.submitDisabled}
      pendingExtra={<span>0:14</span>}
      outcome={p.notice ? { ...NO_OUTCOME, notice: p.notice } : NO_OUTCOME}
    >
      <input aria-label="Field" />
    </FormFrame>
  );
}

test("a disabled sheet primary ignores a click and Enter in a field, and says why", async () => {
  const onSubmit = vi.fn();
  render(<Sheet onSubmit={onSubmit} submitDisabled notice="Pick one." />);
  const go = screen.getByRole("button", { name: "Go" });
  expect(go).toHaveAttribute("aria-disabled", "true");
  expect(go).toHaveAccessibleDescription("Pick one.");
  await userEvent.click(go);
  await userEvent.type(screen.getByLabelText("Field"), "{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("an enabled sheet primary submits", async () => {
  const onSubmit = vi.fn();
  render(<Sheet onSubmit={onSubmit} />);
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(onSubmit).toHaveBeenCalledOnce();
});

test("pending shows the pending label with its extra and ignores a submit", async () => {
  const onSubmit = vi.fn();
  render(<Sheet onSubmit={onSubmit} pending />);
  expect(screen.getByRole("button", { name: /Going…/ })).toHaveTextContent("Going…0:14");
  await userEvent.type(screen.getByLabelText("Field"), "{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
});
