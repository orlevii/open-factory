import type { ImageItem, ServerMessage } from "@open-factory/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { json, mockApi } from "@/test/mock-api";
import { BuildLog, formatBuildDuration, stripAnsi } from "./build-log";

afterEach(() => vi.unstubAllGlobals());

function fakeHub() {
  const listeners = new Set<(m: ServerMessage) => void>();
  const hub: WsHub = {
    send: () => true,
    listen: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: "open",
    openCount: 1,
  };
  const emit = (m: ServerMessage) =>
    act(() => {
      for (const fn of listeners) fn(m);
    });
  return { hub, emit };
}

const item = (p: Partial<ImageItem> = {}): ImageItem => ({
  name: "playwright",
  status: "building",
  usedBy: [],
  ...p,
});

function renderLog(it: ImageItem) {
  const { hub, emit } = fakeHub();
  const view = render(
    <WsContext.Provider value={hub}>
      <BuildLog name={it.name} item={it} />
    </WsContext.Provider>,
  );
  const rerender = (next: ImageItem) =>
    view.rerender(
      <WsContext.Provider value={hub}>
        <BuildLog name={next.name} item={next} />
      </WsContext.Provider>,
    );
  return { emit, rerender };
}

test("stripAnsi removes colour and cursor sequences", () => {
  expect(stripAnsi("\u001b[1m\u001b[31mStep 1/2\u001b[0m : FROM x")).toBe("Step 1/2 : FROM x");
});

test("formatBuildDuration: seconds, minutes and hours", () => {
  expect(formatBuildDuration(12_000)).toBe("12s");
  expect(formatBuildDuration(72_000)).toBe("1m 12s");
  expect(formatBuildDuration(3_720_000)).toBe("1h 2m");
});

test("log: role=log with aria-live=off; the snapshot loads, then image_build frames append; ANSI stripped", async () => {
  mockApi({
    "GET /api/images/playwright/log": () =>
      json({ state: "succeeded", lines: ["old line from the last build"] }),
  });
  const { emit } = renderLog(item({ status: "built" }));
  const log = await screen.findByRole("log");
  expect(log).toHaveAttribute("aria-live", "off");
  expect(await screen.findByText(/old line from the last build/)).toBeInTheDocument();

  // A new build starts: the panel clears and follows its frames.
  emit({ type: "image_build", name: "playwright", state: "building" });
  expect(log.textContent).toBe("");
  emit({
    type: "image_build",
    name: "playwright",
    state: "building",
    lines: ["\u001b[34mStep 1/2 : FROM base\u001b[0m", "Step 2/2 : RUN true"],
  });
  emit({ type: "image_build", name: "other", state: "building", lines: ["not mine"] });
  emit({
    type: "image_build",
    name: "playwright",
    state: "building",
    lines: ["Successfully built"],
  });
  expect(log.textContent).toBe("Step 1/2 : FROM base\nStep 2/2 : RUN true\nSuccessfully built");
});

test("log: joined mid-build, a frame refetches the log instead of guessing which lines are new", async () => {
  let lines = ["a", "b"];
  const api = mockApi({
    "GET /api/images/playwright/log": () => json({ state: "building", lines }),
  });
  const { emit } = renderLog(item());
  const log = await screen.findByRole("log");
  await vi.waitFor(() => expect(log.textContent).toBe("a\nb"));
  lines = ["a", "b", "c", "d"];
  emit({ type: "image_build", name: "playwright", state: "building", lines: ["b", "c", "d"] });
  await vi.waitFor(() => expect(log.textContent).toBe("a\nb\nc\nd"));
  expect(api.calls.filter((c) => c.url.endsWith("/log"))).toHaveLength(2);
});

test("log: joined mid-build, a burst of frames refetches at most once a second (leading and trailing)", async () => {
  const api = mockApi({
    "GET /api/images/playwright/log": () => json({ state: "building", lines: ["a"] }),
  });
  const logCalls = () => api.calls.filter((c) => c.url.endsWith("/log")).length;
  const { emit } = renderLog(item());
  await vi.waitFor(() => expect(screen.getByRole("log").textContent).toBe("a"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const batch = () =>
      emit({ type: "image_build", name: "playwright", state: "building", lines: ["x"] });
    batch(); // leading: refetches at once
    expect(logCalls()).toBe(2);
    batch();
    batch();
    expect(logCalls()).toBe(2);
    act(() => vi.advanceTimersByTime(1000)); // trailing: one refetch for the two held back
    expect(logCalls()).toBe(3);
    act(() => vi.advanceTimersByTime(5000));
    expect(logCalls()).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

test("log: a failed log fetch says so with Retry", async () => {
  let ok = false;
  mockApi({
    "GET /api/images/playwright/log": () =>
      ok
        ? json({ state: "succeeded", lines: ["done"] })
        : json({ error: { code: "x", message: "boom" } }, 500),
  });
  renderLog(item({ status: "built" }));
  expect(await screen.findByText("Couldn't load the build log.")).toBeInTheDocument();
  ok = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("done")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load the build log.")).toBeNull();
});

test("log: success line from the list's lastBuild; failure shows Build failed and the error", async () => {
  mockApi({ "GET /api/images/playwright/log": () => json({ state: "building", lines: [] }) });
  const { emit, rerender } = renderLog(item());
  await screen.findByRole("log");
  emit({ type: "image_build", name: "playwright", state: "building" });
  emit({ type: "image_build", name: "playwright", state: "succeeded" });
  rerender(
    item({
      status: "built",
      builtAt: new Date().toISOString(),
      lastBuild: {
        state: "succeeded",
        finishedAt: new Date().toISOString(),
        durationMs: 72_000,
      },
    }),
  );
  expect(screen.getByText("Built playwright in 1m 12s.")).toBeInTheDocument();

  emit({ type: "image_build", name: "playwright", state: "building" });
  emit({ type: "image_build", name: "playwright", state: "failed" });
  rerender(
    item({
      status: "failed",
      lastBuild: {
        state: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: 3_000,
        error: "The command '/bin/sh -c false' returned a non-zero code: 1",
      },
    }),
  );
  expect(screen.getByText("Build failed")).toBeInTheDocument();
  expect(
    screen.getByText("The command '/bin/sh -c false' returned a non-zero code: 1"),
  ).toBeInTheDocument();
});

test("log: scrolling up pauses auto-scroll and shows Jump to latest; Copy copies the plain text", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  mockApi({
    "GET /api/images/playwright/log": () => json({ state: "building", lines: ["one", "two"] }),
  });
  renderLog(item());
  const log = await screen.findByRole("log");
  await vi.waitFor(() => expect(log.textContent).toBe("one\ntwo"));
  Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
  expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  log.scrollTop = 100;
  act(() => log.dispatchEvent(new Event("scroll")));
  const jump = await screen.findByRole("button", { name: "Jump to latest" });
  await userEvent.click(jump);
  expect(log.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("one\ntwo");
  expect(await screen.findByText("Copied.")).toBeInTheDocument();
});
