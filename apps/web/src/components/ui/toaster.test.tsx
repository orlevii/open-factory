import { ApiError } from "@open-factory/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { notify, Toaster, toastDuration } from "./toaster";

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => {
  vi.restoreAllMocks();
  // Sonner's store outlives a render; clear it so the next test starts with no toasts.
  act(() => {
    toast.dismiss();
  });
});

test("a toast shows its text and Undo runs once", async () => {
  const undo = vi.fn(async () => {});
  render(<Toaster />);
  act(() => notify({ text: "Archived @ada.", undo }));
  const button = await screen.findByRole("button", { name: "Undo" });
  await userEvent.click(button);
  await userEvent.click(button);
  expect(undo).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Archived @ada.")).toBeInTheDocument();
});

test("a failing undo shows the server's message", async () => {
  const undo = async () => {
    throw new ApiError(409, "conflict", "Already restored.", {});
  };
  render(<Toaster />);
  act(() => notify({ text: "Deleted S-1.", undo }));
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Already restored.")).toBeInTheDocument();
});

test("an action button runs its callback", async () => {
  const run = vi.fn();
  render(<Toaster />);
  act(() => notify({ text: "Created T-1.", action: { label: "Open", run } }));
  await userEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(run).toHaveBeenCalledTimes(1);
});

test("a toast is held while a modal is open, shown when it closes, and the observer disconnects", async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("data-state", "open");
  document.body.append(modal);
  render(<Toaster />);
  act(() => notify({ text: "Held toast." }));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("Held toast.")).toBeNull();
  disconnect.mockClear();
  await act(async () => {
    modal.remove();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(await screen.findByText("Held toast.")).toBeInTheDocument();
  await waitFor(() => expect(disconnect).toHaveBeenCalled());
});

test("duration is 60ms per character, at least 5s", () => {
  expect(toastDuration("x".repeat(120))).toBe(7200);
  expect(toastDuration("short")).toBe(5000);
});
