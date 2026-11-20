import { ApiError } from "@open-factory/shared";
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
  expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("aria-disabled", "true");
  expect(onOpenChange).not.toHaveBeenCalled();
  done();
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

test("a rejected onConfirm keeps the dialog open and shows the message in an alert; a retry closes it", async () => {
  const onConfirm = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new ApiError(409, "credential_in_use", "Still used by dev."))
    .mockResolvedValueOnce(undefined);
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Still used by dev.");
  expect(onOpenChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

test("a non-API rejection shows the generic message", async () => {
  const onConfirm = vi.fn(() => Promise.reject(new Error("boom")));
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="T"
      body="B"
      confirmLabel="Go"
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
});

test("while pending the action keeps focus, and Escape and Cancel are ignored", async () => {
  const onConfirm = vi.fn(() => new Promise<void>(() => {}));
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
  expect(screen.getByRole("button", { name: "Go" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).not.toHaveBeenCalled();
});
