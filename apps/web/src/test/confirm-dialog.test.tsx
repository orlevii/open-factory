import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "@/components/confirm-dialog";

test("names the action, Cancel focused first, confirm runs the action", async () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete secret GH_TOKEN?"
      body="Its value is erased."
      confirmLabel="Delete GH_TOKEN"
      onConfirm={onConfirm}
    />,
  );
  expect(screen.getByRole("alertdialog", { name: "Delete secret GH_TOKEN?" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Delete GH_TOKEN" }));
  expect(onConfirm).toHaveBeenCalled();
});

test("Escape cancels without confirming", async () => {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="T"
      body="B"
      confirmLabel="Go"
      onConfirm={onConfirm}
    />,
  );
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("stays pending until onConfirm resolves, then closes", async () => {
  let done: () => void = () => {};
  const onConfirm = vi.fn(() => new Promise<void>((r) => (done = r)));
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="T"
      body="B"
      confirmLabel="Go"
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
  expect(onOpenChange).not.toHaveBeenCalled();
  done();
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});
