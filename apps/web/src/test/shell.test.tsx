import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WsOptions, WsStatus } from "@/lib/ws";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ onStatus: undefined as ((s: WsStatus) => void) | undefined }));
vi.mock("@/lib/ws", () => ({
  connectWs: (opts: WsOptions) => {
    ws.onStatus = opts.onStatus;
    return { close() {}, status: () => "connecting", send: () => true };
  },
}));

beforeEach(() => {
  ws.onStatus = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

test("every screen has one page h1 in the shared header; the dashboard is Home", async () => {
  renderApp("/", alice);
  expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(document.title).toBe("Home · Open Factory");
  const inbox = screen.getByRole("region", { name: "Inbox" });
  expect(within(inbox).getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/inbox");
  const agents = screen.getByRole("region", { name: "Agents" });
  expect(within(agents).getByRole("link", { name: "Open agents" })).toHaveAttribute(
    "href",
    "/agents",
  );
});

test("the skip link is the first focusable element and targets main#content", async () => {
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  await userEvent.tab();
  const skip = screen.getByRole("link", { name: "Skip to content" });
  expect(skip).toHaveFocus();
  expect(skip).toHaveAttribute("href", "#content");
  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("id", "content");
  expect(main).toHaveAttribute("tabindex", "-1");
});

test("activating the skip link focuses main without navigating", async () => {
  const { router } = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  await userEvent.click(screen.getByRole("link", { name: "Skip to content" }));
  expect(screen.getByRole("main")).toHaveFocus();
  expect(router.state.location.pathname).toBe("/inbox");
  expect(router.state.location.hash).toBe("");
});

test("the active section link is marked aria-current=page", async () => {
  renderApp("/agents", alice);
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  expect(within(nav).getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
});

test("an unknown path shows the not-found state with a way home", async () => {
  renderApp("/nope", alice);
  expect(await screen.findByRole("heading", { name: "Page not found." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(document.title).toBe("Page not found · Open Factory");
});

/** Fake timers only (no real-time drift). Returns the fake ms spent until the screen rendered, so the
 *  grace-period assertions are deterministic instead of racing the wall clock. */
async function renderInboxWithFakeTimers() {
  vi.useFakeTimers();
  const t0 = Date.now();
  renderApp("/inbox", alice);
  // vi.waitFor advances the fake clock between checks.
  await vi.waitFor(() => screen.getByRole("heading", { level: 1, name: "Inbox" }));
  return Date.now() - t0;
}
const strip = () => screen.queryByText("Connection lost. Reconnecting…");

test("on first connect the strip appears after 5s, not before", async () => {
  // The grace timer starts when the layout mounts, somewhere inside the first `elapsed` ms.
  const elapsed = await renderInboxWithFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(5_000 - elapsed - 1));
  expect(strip()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(elapsed + 1));
  expect(strip()).toBeInTheDocument();
  expect(strip()?.closest('[role="status"]')).toBeInTheDocument();
  act(() => ws.onStatus?.("open"));
  expect(strip()).toBeNull();
});

test("after a drop the strip appears at 3s; reconnect flips don't restart the clock", async () => {
  await renderInboxWithFakeTimers();
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(strip()).toBeNull();

  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(1_500));
  act(() => ws.onStatus?.("connecting"));
  await act(() => vi.advanceTimersByTimeAsync(1_499));
  expect(strip()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(strip()).toBeInTheDocument();

  act(() => ws.onStatus?.("open"));
  expect(strip()).toBeNull();
});

test("a short blip never shows the strip", async () => {
  await renderInboxWithFakeTimers();
  act(() => ws.onStatus?.("open"));
  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(2_999));
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(strip()).toBeNull();
});
