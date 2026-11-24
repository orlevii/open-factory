import { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { onLibraryChanged } from "./library";

beforeEach(() => {
  vi.useFakeTimers();
  fakeMatchMedia.install(false);
});
afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.useRealTimers();
});

const frame = { type: "library_changed" } as const;

test("ten frames in one tick refetch the library once, when the window ends", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  for (let i = 0; i < 10; i++) onLibraryChanged(qc, frame);
  expect(invalidate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(249);
  expect(invalidate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library"] });
});

test("a frame after the window opens a new one", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  onLibraryChanged(qc, frame);
  vi.advanceTimersByTime(250);
  onLibraryChanged(qc, frame);
  vi.advanceTimersByTime(250);
  expect(invalidate).toHaveBeenCalledTimes(2);
});

test("a failed background add is a toast at once, even inside a coalesced window", () => {
  const qc = new QueryClient();
  vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  render(createElement(Toaster));
  onLibraryChanged(qc, frame);
  act(() => onLibraryChanged(qc, { ...frame, addFailed: "acme/skills" }));
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByText("Couldn't add acme/skills.")).toBeInTheDocument();
});
