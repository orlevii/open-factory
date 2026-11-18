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
    return { close() {}, status: () => "connecting" };
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
});

test("the reconnect strip shows only after the grace period and hides once open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  const strip = () => screen.queryByText("Connection lost. Reconnecting…");

  // First connect: 5s of grace.
  await act(() => vi.advanceTimersByTimeAsync(4_900));
  expect(strip()).toBeNull();
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(strip()).toBeNull();

  // Later drops: 3s, and the reconnect loop's closed/connecting flips don't restart the clock.
  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(1_500));
  act(() => ws.onStatus?.("connecting"));
  await act(() => vi.advanceTimersByTimeAsync(1_400));
  expect(strip()).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(strip()).toBeInTheDocument();
  expect(strip()?.closest('[role="status"]')).toBeInTheDocument();

  act(() => ws.onStatus?.("open"));
  expect(strip()).toBeNull();
});

test("a short blip never shows the strip", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  act(() => ws.onStatus?.("open"));
  act(() => ws.onStatus?.("closed"));
  await act(() => vi.advanceTimersByTimeAsync(2_900));
  act(() => ws.onStatus?.("open"));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.queryByText("Connection lost. Reconnecting…")).toBeNull();
});
