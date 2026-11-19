import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { formatInboxTime } from "./inbox-list";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const item = (n: number, o: Record<string, unknown> = {}) => ({
  id: `i${n}`,
  messageId: `m${n}`,
  from: { kind: "agent", name: "dev" },
  to: "@humans",
  preview: `preview ${n}`,
  urgent: false,
  createdAt: new Date(2026, 10, 19, 14, 32).toISOString(),
  link: { agentSlug: "dev", seq: 40 + n },
  ...o,
});

test("rows link to the sender's call with an accessible name; the preview is the description", async () => {
  mockApi({
    "GET /api/inbox?": () => json({ items: [item(1, { urgent: true })], nextCursor: null }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: "From @dev to @humans, urgent, 14:32" });
  expect(link).toHaveAttribute("href", "/agents/dev?event=41");
  expect(link).toHaveAccessibleDescription("preview 1");
  expect(screen.getByRole("list", { name: "Inbox" })).toBeInTheDocument();
});

test("a factory item names what it is about; a row without seq links to the session", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        items: [
          item(1, {
            from: { kind: "factory", name: "factory" },
            about: "ops",
            link: { agentSlug: "ops" },
          }),
        ],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", {
    name: "From Factory about @ops to @humans, 14:32",
  });
  expect(link).toHaveAttribute("href", "/agents/ops");
});

test("empty state", async () => {
  mockApi({ "GET /api/inbox?": () => json({ items: [], nextCursor: null }) });
  renderApp("/inbox", alice);
  expect(await screen.findByText("Nothing in your inbox.")).toBeInTheDocument();
});

test("fetch error shows one line and Retry, which refetches", async () => {
  const api = mockApi({
    "GET /api/inbox?": () => json({ error: { code: "x", message: "x" } }, 500),
  });
  renderApp("/inbox", alice);
  expect(await screen.findByText("Couldn't load the inbox.")).toBeInTheDocument();
  api.on("GET /api/inbox?", () => json({ items: [item(1)], nextCursor: null }));
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /From @dev/ })).toBeInTheDocument();
});

test("Load earlier fetches the next page, merges by id and moves focus to the first new row", async () => {
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? json({ items: [item(1), item(0)], nextCursor: null })
        : json({ items: [item(2), item(1)], nextCursor: "c1" }),
  });
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(3));
  expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  expect(
    screen.getByRole("link", { name: /From @dev.*14:32/, description: "preview 0" }),
  ).toHaveFocus();
});

test("a failed page load says so inline and Retry loads it", async () => {
  let fail = true;
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? fail
          ? json({ error: { code: "x", message: "x" } }, 500)
          : json({ items: [item(0)], nextCursor: null })
        : json({ items: [item(1)], nextCursor: "c1" }),
  });
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("Couldn't load earlier messages.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /From @dev/ })).toBeInTheDocument(); // loaded rows stay
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(2));
});

test("inbox_changed refetches and a new row appears at the top", async () => {
  let items = [item(1)];
  mockApi({ "GET /api/inbox?": () => json({ items, nextCursor: null }) });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /From @dev/ });
  items = [item(2), item(1)];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(2));
  expect(
    within(screen.getByRole("list", { name: "Inbox" })).getAllByRole("link")[0],
  ).toHaveAttribute("href", "/agents/dev?event=42");
});

test("arrow keys move focus between rows; Home and End jump", async () => {
  mockApi({
    "GET /api/inbox?": () => json({ items: [item(3), item(2), item(1)], nextCursor: null }),
  });
  renderApp("/inbox", alice);
  const links = await screen.findAllByRole("link", { name: /^From @dev/ });
  links[0]?.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(links[1]).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(links[2]).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}{Home}");
  expect(links[0]).toHaveFocus();
});

test("past times: today, yesterday, this year, another year", () => {
  const now = new Date(2026, 10, 19, 15, 0);
  expect(formatInboxTime(new Date(2026, 10, 19, 9, 5), now)).toBe("09:05");
  expect(formatInboxTime(new Date(2026, 10, 18, 23, 59), now)).toBe("Yesterday 23:59");
  expect(formatInboxTime(new Date(2026, 8, 27, 9, 10), now)).toBe("27 Sep 09:10");
  expect(formatInboxTime(new Date(2025, 10, 27, 9, 10), now)).toBe("27 Nov 2025 09:10");
});
