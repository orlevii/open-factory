import { ApiError } from "@open-factory/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { notify, resetToasts, Toaster, toastDuration } from "./toaster";

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
  expect(button).toBeDisabled();
  button.removeAttribute("disabled");
  fireEvent.click(button);
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

test("an undo that throws synchronously shows the fallback", async () => {
  const undo = (() => {
    throw new Error("boom");
  }) as () => Promise<void>;
  render(<Toaster />);
  act(() => notify({ text: "Deleted S-2.", undo }));
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Couldn't undo: can't reach the server.")).toBeInTheDocument();
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

test("a held toast waits until the toaster is no longer aria-hidden", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  root.setAttribute("aria-hidden", "true");
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("data-state", "open");
  document.body.append(modal);
  render(<Toaster />, { container: root });
  act(() => notify({ text: "Late toast." }));
  // The modal's state flips to closed while Radix's aria-hidden is still on the toaster's tree.
  await act(async () => {
    modal.setAttribute("data-state", "closed");
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(screen.queryByText("Late toast.")).toBeNull();
  await act(async () => {
    root.removeAttribute("aria-hidden");
    modal.remove();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(await screen.findByText("Late toast.")).toBeInTheDocument();
  root.remove();
});

test("resetToasts drops held toasts and stops watching", async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("data-state", "open");
  document.body.append(modal);
  render(<Toaster />);
  act(() => notify({ text: "Previous user's toast." }));
  disconnect.mockClear();
  resetToasts();
  expect(disconnect).toHaveBeenCalled();
  await act(async () => {
    modal.remove();
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(screen.queryByText("Previous user's toast.")).toBeNull();
  // The next toast is not queued behind the dropped one.
  act(() => notify({ text: "Fresh toast." }));
  expect(await screen.findByText("Fresh toast.")).toBeInTheDocument();
});

test("while held, the release check runs at most once per animation frame", async () => {
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("data-state", "open");
  document.body.append(modal);
  render(<Toaster />);
  act(() => notify({ text: "Held." }));
  const raf = vi.spyOn(window, "requestAnimationFrame");
  const query = vi.spyOn(document, "querySelector");
  // A burst of DOM changes behind the modal (a streaming session) in one task.
  await act(async () => {
    for (let i = 0; i < 20; i++) document.body.append(document.createElement("span"));
    await Promise.resolve();
  });
  expect(raf).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(query.mock.calls.length).toBeLessThanOrEqual(2);
  expect(screen.queryByText("Held.")).toBeNull();
  await act(async () => {
    modal.remove();
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(await screen.findByText("Held.")).toBeInTheDocument();
});

test("duration is 60ms per character, at least 5s", () => {
  expect(toastDuration("x".repeat(120))).toBe(7200);
  expect(toastDuration("short")).toBe(5000);
});

test("desktop: rem type, an 8px gap, a width capped to the content column, an offset focus ring", async () => {
  const { container } = render(<Toaster />);
  act(() => notify({ text: "Created T-1.", action: { label: "Open", run: () => {} } }));
  const button = await screen.findByRole("button", { name: "Open" });
  const toaster = container.ownerDocument.querySelector("[data-sonner-toaster]") as HTMLElement;
  expect(toaster.style.getPropertyValue("--gap")).toBe("8px");
  expect(toaster.style.getPropertyValue("--width")).toContain("var(--composer-inset-right");
  const item = button.closest("[data-sonner-toast]") as HTMLElement;
  expect(item.className).toContain("text-[0.8125rem]");
  expect(item.className).not.toMatch(/\[\d+px\]/);
  expect(button).toHaveClass("focus-visible:outline-offset-2");
});
