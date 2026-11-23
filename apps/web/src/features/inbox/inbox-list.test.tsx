import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatInboxTime } from "@/features/session/format";
import { fakeMatchMedia } from "@/test/fake-match-media";
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
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.matchMedia = originalMatchMedia;
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

test("a factory item names what it is about; a row without seq links to the chat", async () => {
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
  expect(link).toHaveAttribute("href", "/agents/ops/chat");
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

const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
const chat = (slug: string, name: string, o: Record<string, unknown> = {}) => ({
  agent: {
    slug,
    displayName: name,
    template: slug,
    avatarVersion: null,
    color: null,
    kind: "persistent",
    status: "idle",
    archivedAt: null,
    ...((o.agent as object) ?? {}),
  },
  unread: 3,
  latest: {
    messageId: `${slug}-m`,
    preview: `${name} says hi`,
    createdAt: at(14, 20),
    urgent: false,
    ...((o.latest as object) ?? {}),
  },
  ...(o.unread !== undefined ? { unread: o.unread } : {}),
});
const hrefs = () =>
  within(screen.getByRole("list", { name: "Inbox" }))
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"));
const rowOf = (slug: string) =>
  document.querySelector<HTMLElement>(`a[data-inbox-id="chat:${slug}"]`);

test("a chat row: the agent chip, '· 3 new', Urgent, the time, the preview as its description", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [chat("ada", "Ada", { latest: { urgent: true } })],
        items: [],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: "Unread, Ada, 3 new, urgent, 14:20" });
  expect(link).toHaveAttribute("href", "/agents/ada/chat");
  expect(link).toHaveAccessibleDescription("Ada says hi");
  expect(within(link).getByText("· 3 new")).toBeInTheDocument();
  expect(within(link).getByText("Urgent")).toBeInTheDocument();
  expect(within(link).getByText("14:20")).toBeInTheDocument();
  // The handle is in the name's tooltip.
  await userEvent.hover(within(link).getByText("Ada"));
  expect((await screen.findAllByText("Ada @ada")).length).toBeGreaterThan(0);
});

test("a spawned agent keeps its suffix; an ended agent says archived or terminated; counts are formatted", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [
          chat("ada-1", "Ada · ab12", { agent: { kind: "ephemeral" }, unread: 1200 }),
          chat("old", "Old", {
            agent: { archivedAt: at(9, 0) },
            latest: { createdAt: at(14, 10) },
          }),
          chat("gone", "Gone", {
            agent: { status: "terminated" },
            latest: { createdAt: at(14, 5) },
          }),
        ],
        items: [],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const spawned = await screen.findByRole("link", { name: /^Unread, Ada · ab12, 1,200 new/ });
  expect(within(spawned).getByText("· 1,200 new")).toBeInTheDocument();
  expect(within(rowOf("old") as HTMLElement).getByText("archived")).toBeInTheDocument();
  expect(within(rowOf("gone") as HTMLElement).getByText("terminated")).toBeInTheDocument();
});

test("chats and items are interleaved by time", async () => {
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [chat("ada", "Ada", { latest: { createdAt: at(14, 20) } })],
        items: [item(1), item(2, { createdAt: at(14, 10) })],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  expect(hrefs()).toEqual([
    "/agents/dev/session?event=41",
    "/agents/ada/chat",
    "/agents/dev/session?event=42",
  ]);
});

test("a chat older than the oldest loaded item waits until a page reaches it", async () => {
  mockApi({
    "GET /api/inbox?": (_b, url) =>
      url.includes("before=c1")
        ? json({ items: [item(2, { createdAt: at(12, 0) })], nextCursor: null })
        : json({
            chats: [chat("ada", "Ada"), chat("bo", "Bo", { latest: { createdAt: at(13, 0) } })],
            items: [item(1, { createdAt: at(14, 0) })],
            nextCursor: "c1",
          }),
  });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  expect(rowOf("bo")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  await waitFor(() => expect(rowOf("bo")).not.toBeNull());
  expect(hrefs()).toEqual([
    "/agents/ada/chat",
    "/agents/dev/session?event=41",
    "/agents/bo/chat",
    "/agents/dev/session?event=42",
  ]);
});

test("the Inbox is empty only with no chats and no items", async () => {
  mockApi({
    "GET /api/inbox?": () => json({ chats: [chat("ada", "Ada")], items: [], nextCursor: null }),
  });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  expect(screen.queryByText("Nothing in your inbox.")).toBeNull();
});

test("a read chat stays, read and with no count, while the pointer is in the list, and leaves once it is out", async () => {
  let chats = [chat("ada", "Ada"), chat("bo", "Bo", { latest: { createdAt: at(14, 10) } })];
  mockApi({ "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }) });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  const list = screen.getByRole("list", { name: "Inbox" });
  await userEvent.hover(list);
  chats = [chats[1] as (typeof chats)[number]];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Ada, 14:20" })).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Ada, 14:20" })).not.toHaveTextContent("new");
  expect(rowOf("bo")).not.toBeNull();
  await userEvent.unhover(list);
  await waitFor(() => expect(rowOf("ada")).toBeNull());
  expect(rowOf("bo")).not.toBeNull();
});

test("a new message re-sorts a chat only after the pointer and the focus have left", async () => {
  let chats = [
    chat("ada", "Ada", { latest: { createdAt: at(14, 10) } }),
    chat("bo", "Bo", { latest: { createdAt: at(14, 20) } }),
  ];
  mockApi({ "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }) });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  expect(hrefs()).toEqual(["/agents/bo/chat", "/agents/ada/chat"]);
  const list = screen.getByRole("list", { name: "Inbox" });
  await userEvent.hover(list);
  act(() => (rowOf("bo") as HTMLElement).focus());
  chats = [
    chat("ada", "Ada", { unread: 4, latest: { createdAt: at(14, 40) } }),
    chats[1] as (typeof chats)[number],
  ];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  // The count is live; the order waits.
  await waitFor(() =>
    expect(within(rowOf("ada") as HTMLElement).getByText("· 4 new")).toBeVisible(),
  );
  expect(hrefs()).toEqual(["/agents/bo/chat", "/agents/ada/chat"]);
  // The pointer leaves, the focus is still in: still held.
  await userEvent.unhover(list);
  expect(hrefs()).toEqual(["/agents/bo/chat", "/agents/ada/chat"]);
  act(() => (rowOf("bo") as HTMLElement).blur());
  await waitFor(() => expect(hrefs()).toEqual(["/agents/ada/chat", "/agents/bo/chat"]));
});

test("j and k keep the list held: a chat that was read stays until the focus leaves", async () => {
  fakeMatchMedia.installWidth(1280);
  let chats = [
    chat("ada", "Ada", { latest: { createdAt: at(14, 20) } }),
    chat("bo", "Bo", { latest: { createdAt: at(14, 10) } }),
  ];
  mockApi({ "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }) });
  renderApp("/inbox", alice);
  await screen.findByRole("link", { name: /^Unread, Ada/ });
  act(() => (rowOf("ada") as HTMLElement).focus());
  chats = [chats[0] as (typeof chats)[number]];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Bo, 14:10" })).toBeInTheDocument());
  await userEvent.keyboard("j");
  expect(rowOf("bo")).not.toBeNull();
  act(() => (document.activeElement as HTMLElement).blur());
  await waitFor(() => expect(rowOf("bo")).toBeNull());
});

test("a chat shown in the pane doesn't bump its count when a message arrives", async () => {
  fakeMatchMedia.installWidth(1280);
  let chats = [chat("ada", "Ada", { unread: 2 })];
  mockApi({ "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }) });
  renderApp("/inbox?item=chat:ada", alice);
  await screen.findByRole("link", { name: /^Unread, Ada, 2 new/ });
  chats = [chat("ada", "Ada", { unread: 3 })];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await waitFor(() => expect(rowOf("ada")?.getAttribute("aria-label")).toMatch(/2 new/));
  await new Promise((r) => setTimeout(r, 50));
  expect(rowOf("ada")?.getAttribute("aria-label")).toMatch(/2 new/);
});

test("the shown chat's count only goes down: read in the pane, a later message stays uncounted", async () => {
  fakeMatchMedia.installWidth(1280);
  let chats = [chat("ada", "Ada", { unread: 2 })];
  mockApi({ "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }) });
  const app = renderApp("/inbox?item=chat:ada", alice);
  await screen.findByRole("link", { name: /^Unread, Ada, 2 new/ });
  // The pane read it: the cache's row is read (the server drops such a row, so only the cache holds it).
  act(() =>
    app.queryClient.setQueryData(["inbox"], (d: { pages: { chats: unknown[] }[] }) => ({
      ...d,
      pages: d.pages.map((p) => ({ ...p, chats: [chat("ada", "Ada", { unread: 0 })] })),
    })),
  );
  await waitFor(() => expect(rowOf("ada")?.getAttribute("aria-label")).toBe("Ada, 14:20"));
  chats = [chat("ada", "Ada", { unread: 1 })];
  act(() => ws.onMessage?.({ type: "inbox_changed" }));
  await new Promise((r) => setTimeout(r, 80));
  expect(rowOf("ada")?.getAttribute("aria-label")).toBe("Ada, 14:20");
});

test("resting the pointer on a chat row warms its chat", async () => {
  fakeMatchMedia.installWidth(1280);
  const api = mockApi({
    "GET /api/inbox?": () => json({ chats: [chat("ada", "Ada")], items: [], nextCursor: null }),
    "GET /api/agents/ada/chat?": () =>
      json({ entries: [], nextCursor: null, newerCursor: null, working: null }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: /^Unread, Ada/ });
  const warmed = () => api.calls.some((c) => c.url.startsWith("/api/agents/ada/chat"));
  await userEvent.hover(link);
  await userEvent.unhover(link);
  await new Promise((r) => setTimeout(r, 300));
  expect(warmed()).toBe(false);
  await userEvent.hover(link);
  await waitFor(() => expect(warmed()).toBe(true));
});

test("below 1024px a click on a chat row navigates to its chat", async () => {
  fakeMatchMedia.installWidth(800);
  mockApi({
    "GET /api/inbox?": () => json({ chats: [chat("ada", "Ada")], items: [], nextCursor: null }),
  });
  const app = renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("link", { name: /^Unread, Ada/ }));
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/agents/ada/chat"));
});

test("at 1024px and up a click selects the chat (?item=chat:<slug>) and marks nothing read", async () => {
  fakeMatchMedia.installWidth(1280);
  const api = mockApi({
    "GET /api/inbox?": () => json({ chats: [chat("ada", "Ada")], items: [], nextCursor: null }),
  });
  const app = renderApp("/inbox", alice);
  await userEvent.click(await screen.findByRole("link", { name: /^Unread, Ada/ }));
  await waitFor(() => expect(app.router.state.location.search).toEqual({ item: "chat:ada" }));
  expect(rowOf("ada")).toHaveAttribute("aria-current", "true");
  expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
});

const credItem = (c: { name: string; expiresAt: string | null; current: boolean }, o = {}) =>
  item(1, {
    kind: "credential",
    read: false,
    from: { kind: "factory", name: "factory" },
    to: "@alice",
    credential: c,
    link: { kind: "credential", name: c.name },
    ...o,
  });

test("credential row: 'Factory about work' then the live state; the accessible name names the expiry", async () => {
  // Now is 19 Nov 2026 15:00 local; 9 days on.
  const expiresAt = new Date(2026, 10, 28, 12, 0).toISOString();
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [credItem({ name: "work", expiresAt, current: true })],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", {
    name: "Unread, Factory, work expires in 9 days, 14:32",
  });
  expect(link).toHaveTextContent(/^Factory\s*about work/);
  expect(link).toHaveTextContent("Expires in 9 days");
});

test("credential row below 1024px links to /settings/credentials?credential=work", async () => {
  fakeMatchMedia.installWidth(800);
  const expiresAt = new Date(2026, 10, 28, 12, 0).toISOString();
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [credItem({ name: "work", expiresAt, current: true })],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: /Factory, work expires/ });
  expect(link).toHaveAttribute("href", "/settings/credentials?credential=work");
});

test("a credential that was signed in again reads 'Signed in again'; never a session link", async () => {
  const expiresAt = new Date(2026, 10, 12).toISOString();
  mockApi({
    "GET /api/inbox?": () =>
      json({
        chats: [],
        items: [credItem({ name: "work", expiresAt, current: false }, { read: true })],
        nextCursor: null,
      }),
  });
  renderApp("/inbox", alice);
  const link = await screen.findByRole("link", { name: "Factory, work signed in again, 14:32" });
  expect(link).toHaveTextContent("Signed in again");
  expect(link.getAttribute("href")).not.toMatch(/\/agents\//);
});

test("the row's expiry text follows the now prop, not the wall clock (memo contract)", async () => {
  const { InboxRow } = await import("./inbox-row");
  const { render } = await import("@testing-library/react");
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import(
    "@tanstack/react-router"
  );
  const expiresAt = new Date(2026, 10, 28, 12, 0).toISOString();
  const row = credItem({ name: "work", expiresAt, current: true }) as never;
  const rows = (now: number) => <InboxRow item={row} now={now} onOpen={() => {}} />;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ul>{rows(Date.UTC(2026, 10, 19, 12))}</ul> }),
    history: createMemoryHistory(),
  });
  // The system clock stays on 19 Nov; the prop says 27 Nov.
  const { findByText } = render(<RouterProvider router={router} />);
  expect(await findByText("Expires in 9 days")).toBeInTheDocument();
  const later = createRouter({
    routeTree: createRootRoute({ component: () => <ul>{rows(Date.UTC(2026, 10, 27, 12))}</ul> }),
    history: createMemoryHistory(),
  });
  const second = render(<RouterProvider router={later} />);
  expect(await second.findByText("Expires tomorrow")).toBeInTheDocument();
});
