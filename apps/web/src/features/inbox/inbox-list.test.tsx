import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatInboxTime } from "@/features/session/format";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

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
  kind: "notice",
  read: true,
  from: { kind: "agent", name: "dev" },
  to: "@bob",
  preview: `preview ${n}`,
  urgent: false,
  createdAt: new Date(2026, 10, 19, 14, 32).toISOString(),
  link: { kind: "session", agentSlug: "dev", seq: 40 + n },
  ...o,
});

test("rows link to the sender's call with an accessible name; the preview is the description", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({ chats: [], items: [item(1, { urgent: true })], nextCursor: null }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: "From @dev to @bob, urgent, 14:32" });
  expect(link).toHaveAttribute("href", "/agents/dev/session?event=41");
  expect(link).toHaveAccessibleDescription("preview 1");
  expect(screen.getByRole("list", { name: "Inbox" })).toBeInTheDocument();
});

test("a factory item names what it is about; a row without seq links to the session", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [
          item(1, {
            from: { kind: "factory", name: "factory" },
            about: "ops",
            link: { kind: "session", agentSlug: "ops" },
          }),
        ],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", {
    name: "From Factory about @ops to @bob, 14:32",
  });
  expect(link).toHaveAttribute("href", "/agents/ops/session");
});

test("empty state", async () => {
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }) });
  renderApp("/inbox", alice);
  expect(await screen.findByText("Nothing in your inbox.")).toBeInTheDocument();
});

test("fetch error shows one line and Retry, which refetches", async () => {
  const api = mockApi({
    "GET /api/inbox?": () => json({ error: { code: "x", message: "x" } }, 500),
  });
  renderApp("/inbox", alice);
  expect(await screen.findByText("Couldn't load the inbox.")).toBeInTheDocument();
  api.on("GET /api/inbox?", () => json({ chats: [], items: [item(1)], nextCursor: null }));
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /From @dev/ })).toBeInTheDocument();
});

test("Load earlier fetches the next page, merges by id and moves focus to the first new row", async () => {
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? json({ chats: [], items: [item(1), item(0)], nextCursor: null })
        : json({ chats: [], items: [item(2), item(1)], nextCursor: "c1" }),
  });
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(3));
  expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  expect(
    screen.getByRole("link", { name: /From @dev.*14:32/, description: "preview 0" }),
  ).toHaveFocus();
});

test("a page of only already-shown rows focuses the last row, and a later refetch steals no focus", async () => {
  let items = [item(1)];
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? json({ chats: [], items: [item(1)], nextCursor: null })
        : json({ chats: [], items, nextCursor: "c1" }),
  });
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  const row = await screen.findByRole("link", { name: /From @dev/ });
  await waitFor(() => expect(row).toHaveFocus());
  (document.activeElement as HTMLElement).blur();
  items = [item(2), item(1)];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(2));
  expect(document.body).toHaveFocus();
});

test("a failed page load says so inline and Retry loads it", async () => {
  let fail = true;
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? fail
          ? json({ error: { code: "x", message: "x" } }, 500)
          : json({ chats: [], items: [item(0)], nextCursor: null })
        : json({ chats: [], items: [item(1)], nextCursor: "c1" }),
  });
  renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("Couldn't load earlier messages.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /From @dev/ })).toBeInTheDocument(); // loaded rows stay
  expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus(); // not lost to the body
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(2));
});

test("inbox_changed refetches and a new row appears at the top", async () => {
  let items = [item(1)];
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }) });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /From @dev/ });
  items = [item(2), item(1)];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getAllByRole("link", { name: /^From @dev/ })).toHaveLength(2));
  expect(
    within(screen.getByRole("list", { name: "Inbox" })).getAllByRole("link")[0],
  ).toHaveAttribute("href", "/agents/dev/session?event=42");
});

test("arrow keys move focus between rows; Home and End jump", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({ chats: [], items: [item(3), item(2), item(1)], nextCursor: null }),
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

test("a row shows the preview as plain text, the context on its own line and an unclipped time", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [
          item(1, {
            read: false,
            kind: "mention",
            to: "@bob",
            preview: "see **the** [PR](https://x/y) `now`",
            task: { key: "T-6", title: "Ship it" },
            link: { kind: "task", key: "T-6" },
          }),
        ],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: /mentioned you/ });
  expect(link).toHaveAccessibleDescription("see the PR now");
  const row = within(link);
  expect(row.getByText("T-6")).toBeInTheDocument();
  expect(row.getByText("Ship it")).toBeInTheDocument();
  const time = row.getByText("14:32");
  expect(time.className).toContain("shrink-0");
  expect(time.className).toContain("tabular-nums");
  expect(row.getByText("see the PR now").className).toContain("truncate");
});

test("a message row's context line names the recipient; the sender is an agent chip", async () => {
  mockApi({ "GET /api/inbox?": () => json({ chats: [], items: [item(1)], nextCursor: null }) });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: /From @dev/ });
  expect(within(link).getByText("→ @bob")).toBeInTheDocument();
  expect(link.querySelector("[data-agent-avatar], img, svg")).not.toBeNull();
});

test("read rows are muted, unread rows are not", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [item(1, { read: true }), item(2, { read: false })],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const read = await screen.findByRole("link", { name: /^From @dev/, description: "preview 1" });
  const unread = screen.getByRole("link", { name: /^Unread, From @dev/ });
  expect(within(read).getByText("preview 1").className).toContain("text-muted-foreground");
  expect(within(read).getByText("→ @bob").className).toContain("text-muted-foreground");
  expect(unread.className).toContain("");
  expect(within(unread).getByText("→ @bob").className).not.toContain("text-muted-foreground");
});
