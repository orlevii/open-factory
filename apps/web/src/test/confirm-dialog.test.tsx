import { ApiError } from "@open-factory/shared";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { fakeMatchMedia } from "@/test/fake-match-media";

beforeEach(() => {
  fakeMatchMedia.install(false);
});

test("names the action, Cancel focused first, confirm runs the action", async () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete secret GH_TOKEN?"
      body="Its value is erased."
      confirmLabel="Delete GH_TOKEN"
      pendingLabel="Deleting…"
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
      pendingLabel="Going…"
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
      pendingLabel="Going…"
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(screen.getByRole("button", { name: "Going…" })).toHaveAttribute("aria-disabled", "true");
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
      pendingLabel="Going…"
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
      pendingLabel="Going…"
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
      pendingLabel="Going…"
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(screen.getByRole("button", { name: "Going…" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Going…" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).not.toHaveBeenCalled();
});

const SECRET = "A".repeat(64);
const held = () => vi.fn(() => new Promise<void>(() => {}));

function Confirm({
  onConfirm = vi.fn(),
  onOpenChange = () => {},
}: {
  onConfirm?: () => Promise<void> | void;
  onOpenChange?: (o: boolean) => void;
}) {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Delete secret ${SECRET}?`}
      body="Its value is erased."
      confirmLabel={`Delete ${SECRET}`}
      pendingLabel="Deleting…"
      onConfirm={onConfirm}
    />
  );
}

test("desktop: a centered alert dialog that fits the viewport; a long name wraps on the button", async () => {
  render(<Confirm onConfirm={held()} />);
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveAttribute("data-slot", "alert-dialog-content");
  expect(dialog).toHaveClass("sm:max-w-md", "max-h-[calc(100svh-2rem)]");
  expect(dialog).not.toHaveClass("sm:max-w-sm");
  const action = screen.getByRole("button", { name: `Delete ${SECRET}` });
  expect(action).toHaveClass("whitespace-normal", "[overflow-wrap:anywhere]");
  expect(action).not.toHaveClass("whitespace-nowrap");
  // Button's base shrink-0 would keep the max-content width in the flex footer: the label never wraps.
  expect(action).not.toHaveClass("shrink-0");
  expect(action).toHaveClass("shrink", "min-w-0", "max-w-full");
});

test("desktop: while pending the action shows the pending label and a spinner, and Esc does nothing", async () => {
  const onOpenChange = vi.fn();
  render(<Confirm onConfirm={held()} onOpenChange={onOpenChange} />);
  await userEvent.click(screen.getByRole("button", { name: `Delete ${SECRET}` }));
  const action = screen.getByRole("button", { name: "Deleting…" });
  expect(action).toHaveAttribute("aria-busy", "true");
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(action.querySelector("svg.motion-safe\\:animate-spin")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
});

test("mobile: a bottom drawer, the action first and Cancel last, Cancel focused", () => {
  fakeMatchMedia.install(true);
  render(<Confirm />);
  const content = document.querySelector("[data-slot=drawer-content]");
  expect(content).not.toBeNull();
  expect(content).toHaveAttribute("role", "alertdialog");
  expect(screen.getByRole("alertdialog", { name: `Delete secret ${SECRET}?` })).toBe(content);
  const footer = content?.querySelector("[data-slot=drawer-footer]");
  const labels = [...(footer?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  expect(labels).toEqual([`Delete ${SECRET}`, "Cancel"]);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
});

test("mobile: Cancel closes when idle", async () => {
  fakeMatchMedia.install(true);
  const onOpenChange = vi.fn();
  render(<Confirm onOpenChange={onOpenChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("mobile: Escape and an overlay pointerdown close it when idle", async () => {
  fakeMatchMedia.install(true);
  const onOpenChange = vi.fn();
  render(<Confirm onOpenChange={onOpenChange} />);
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  await userEvent.click(document.querySelector("[data-slot=drawer-overlay]") as HTMLElement);
  expect(onOpenChange).toHaveBeenCalledTimes(2);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

test("mobile: while pending, Escape, an overlay pointerdown and Cancel don't close it", async () => {
  fakeMatchMedia.install(true);
  const onOpenChange = vi.fn();
  render(<Confirm onConfirm={held()} onOpenChange={onOpenChange} />);
  await userEvent.click(screen.getByRole("button", { name: `Delete ${SECRET}` }));
  const action = screen.getByRole("button", { name: "Deleting…" });
  expect(action).toHaveAttribute("aria-busy", "true");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(document.querySelector("[data-slot=drawer-overlay]") as HTMLElement);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(document.querySelector("[data-slot=drawer-content]")).toHaveAttribute(
    "data-state",
    "open",
  );
});

test("crossing the breakpoint while pending keeps the primitive and the pending state", async () => {
  const mm = fakeMatchMedia.install(false);
  render(<Confirm onConfirm={held()} />);
  await userEvent.click(screen.getByRole("button", { name: `Delete ${SECRET}` }));
  act(() => mm.set(true));
  expect(screen.getByRole("alertdialog")).toHaveAttribute("data-slot", "alert-dialog-content");
  expect(document.querySelector("[data-slot=drawer-content]")).toBeNull();
  expect(screen.getByRole("button", { name: "Deleting…" })).toHaveAttribute("aria-busy", "true");
});

test("pendingLabel is required", () => {
  const el = (
    // @ts-expect-error pendingLabel is required: every confirmation names its pending state
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="T"
      body="B"
      confirmLabel="Go"
      onConfirm={() => {}}
    />
  );
  expect(el).toBeTruthy();
});
