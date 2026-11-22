import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

test("warmHighlighter schedules the highlighter's import once per page, in idle time", async () => {
  const idle = vi.fn();
  vi.stubGlobal("requestIdleCallback", idle);
  const { warmHighlighter } = await import("./highlight");
  warmHighlighter();
  warmHighlighter();
  expect(idle).toHaveBeenCalledTimes(1);
  expect(idle.mock.calls[0]?.[1]).toMatchObject({ timeout: expect.any(Number) });
});

test("without requestIdleCallback it falls back to a timeout", async () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const { warmHighlighter } = await import("./highlight");
  warmHighlighter();
  warmHighlighter();
  expect(timeout).toHaveBeenCalledTimes(1);
  timeout.mockRestore();
});
