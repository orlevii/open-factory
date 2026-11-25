import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chatQueryOptions } from "@/features/chat/api";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
// A short dwell, so the tests can wait it out for real.
vi.mock("@/lib/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/timing")>()),
  INBOX_DWELL_MS: 300,
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  window.matchMedia = original;
  Element.prototype.scrollIntoView = originalScroll;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 23, 9, 0, s)).toISOString();
const msg = (slug: string, i: number, over: Record<string, unknown> = {}) => ({
  kind: "message",
  id: `${slug}-m${i}`,
  from: `@${slug}`,
  fromKind: "agent",
  body: `${slug} says ${i}`,
  recipients: ["@alice"],
  urgent: false,
  createdAt: at(i),
  state: "delivered",
  ...over,
});
const chatPage = (entries: unknown[]) => ({
  entries,
  nextCursor: null,
  newerCursor: null,
  working: null,
});
const row = (slug: string, name: string, unread: number) => ({
  agent: {
    slug,
    displayName: name,
    template: slug,
    avatarVersion: null,
    color: null,
    kind: "persistent",
    status: "idle",
    archivedAt: null,
  },
  unread,
  firstUnreadId: `${slug}-m3`,
  latest: { messageId: `${slug}-m3`, preview: `${slug} says 3`, createdAt: at(3), urgent: false },
});

let api: MockApi;
let chats: ReturnType<typeof row>[];
let threads: Record<string, unknown[]>;
let unread: { count: number; byAgent: Record<string, number> };
const posts = () => api.calls.filter((c) => c.url.startsWith("/api/inbox/read-from/"));

beforeEach(() => {
  chats = [row("dev", "Dev agent", 2), row("ops", "Ops agent", 1)];
  threads = {
    dev: [msg("dev", 1), msg("dev", 2), msg("dev", 3)],
    ops: [msg("ops", 1), msg("ops", 2), msg("ops", 3)],
  };
  unread = { count: 3, byAgent: { dev: 2, ops: 1 } };
  Element.prototype.scrollIntoView = vi.fn();
  api = mockApi({
    "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }),
    "GET /api/inbox/unread-count": () => json(unread),
    "POST /api/inbox/read-from/dev": () => json({ marked: 2, readAt: at(9) }),
    "POST /api/inbox/read-from/ops": () => json({ marked: 1, readAt: at(9) }),
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/ops": () => json(detail({ slug: "ops", displayName: "Ops agent" })),
    "GET /api/agents/dev/chat?": () => json(chatPage(threads.dev ?? [])),
    "GET /api/agents/ops/chat?": () => json(chatPage(threads.ops ?? [])),
    "GET /api/agents/dev/events?": () =>
      json({ events: [], hasMore: { before: false, after: false } }),
    "GET /api/agents?": () =>
      json({
        agents: [agentSummary(), agentSummary({ slug: "ops", displayName: "Ops agent" })],
        more: false,
        running: { count: 0, max: 8 },
      }),
  });
});

const pane = () => screen.getByRole("region", { name: "Reading pane" });
const listRow = (slug: string) =>
  document.querySelector<HTMLElement>(`a[data-inbox-id="chat:${slug}"]`);
async function visit(path: string) {
  fakeMatchMedia.installWidth(1280);
  const app = renderApp(path, alice);
  await waitFor(() => expect(listRow("dev") ?? listRow("ops")).not.toBeNull());
  return app;
}

test("the pane shows the Chat under a compact strip, with no ⋯, Agent details or ]", async () => {
  await visit("/inbox?item=chat:dev");
  const p = pane();
  expect(await within(p).findByText("dev says 2")).toBeInTheDocument();
  expect(await within(p).findByRole("combobox", { name: "Message to Dev agent" })).toBeVisible();
  const strip = p.querySelector("[data-chat-strip]") as HTMLElement;
  expect(within(strip).getByText("Dev agent")).toBeInTheDocument();
  expect(within(strip).getByRole("link", { name: "Open chat" })).toHaveAttribute(
    "href",
    "/agents/dev/chat",
  );
  expect(within(strip).getByRole("link", { name: "Session" })).toHaveAttribute(
    "href",
    "/agents/dev/session",
  );
  expect(within(p).queryByRole("button", { name: /Agent details|Actions for/ })).toBeNull();
  expect(within(p).queryByRole("complementary")).toBeNull();
});

test("selecting keeps focus in the list; the composer takes focus only on Enter or r", async () => {
  await visit("/inbox");
  await userEvent.click(listRow("dev") as HTMLElement);
  const box = await within(pane()).findByRole("combobox", { name: "Message to Dev agent" });
  expect(box).not.toHaveFocus();
  expect(listRow("dev")).toHaveFocus();
  // Enter on a row selects it and moves focus to its composer.
  (listRow("ops") as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const opsBox = await within(pane()).findByRole("combobox", { name: "Message to Ops agent" });
  await waitFor(() => expect(opsBox).toHaveFocus());
  // `r` does the same without following the link.
  (listRow("dev") as HTMLElement).focus();
  await userEvent.keyboard("r");
  const devBox = await within(pane()).findByRole("combobox", { name: "Message to Dev agent" });
  await waitFor(() => expect(devBox).toHaveFocus());
});

test("retargeting swaps the thread at once: nothing of the old one stays, nothing fades", async () => {
  const app = await visit("/inbox?item=chat:dev");
  await within(pane()).findByText("dev says 3");
  await app.router.navigate({ to: "/inbox", search: { item: "chat:ops" } });
  await within(pane()).findByText("ops says 3");
  expect(within(pane()).queryByText("dev says 3")).toBeNull();
  expect(
    within(pane().querySelector("[data-chat-strip]") as HTMLElement).getByText("Ops agent"),
  ).toBeInTheDocument();
});

test("retargeting never puts a fading row (data-live) on screen, not even for a frame", async () => {
  const app = await visit("/inbox?item=chat:dev");
  await within(pane()).findByText("dev says 3");
  const seen: string[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      const nodes = [...r.addedNodes].filter((n): n is Element => n instanceof Element);
      if (r.type === "attributes" && (r.target as Element).hasAttribute("data-live"))
        seen.push("attribute");
      for (const n of nodes)
        if (n.matches("[data-live]") || n.querySelector("[data-live]")) seen.push("node");
    }
  });
  watch.observe(pane(), { subtree: true, childList: true, attributes: true });
  await app.router.navigate({ to: "/inbox", search: { item: "chat:ops" } });
  await within(pane()).findByText("ops says 3");
  watch.disconnect();
  expect(seen).toEqual([]);
});

test("a thread cached before the row's newest message puts the divider on the right message", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(400);
  fakeMatchMedia.installWidth(1280);
  const app = renderApp("/inbox", alice);
  await waitFor(() => expect(listRow("dev")).not.toBeNull());
  // A prefetch from before the third message: two entries, both older than the unread ones' end.
  app.queryClient.setQueryData(chatQueryOptions("dev").queryKey, {
    pages: [chatPage([msg("dev", 1), msg("dev", 2)]) as never],
    pageParams: [""],
  });
  await app.router.navigate({ to: "/inbox", search: { item: "chat:dev" } });
  await within(pane()).findByText("dev says 3");
  const divider = await waitFor(() => {
    const el = pane().querySelector<HTMLElement>("[data-new-divider]");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(divider.nextElementSibling).toHaveTextContent("dev says 2");
});

test("Mark all read and then Undo before the dwell is up does not make the pane read the chat", async () => {
  const app = await visit("/inbox?item=chat:dev");
  await within(pane()).findByText("dev says 3");
  act(() => app.queryClient.setQueryData(["inbox-unread"], { count: 1, byAgent: { ops: 1 } }));
  await new Promise((r) => setTimeout(r, 60));
  act(() =>
    app.queryClient.setQueryData(["inbox-unread"], { count: 3, byAgent: { dev: 2, ops: 1 } }),
  );
  await new Promise((r) => setTimeout(r, 700));
  expect(posts()).toHaveLength(0);
});

test("it opens at the first unread message, marked New, when the unread are taller than the pane", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(400);
  await visit("/inbox?item=chat:dev");
  const divider = await waitFor(() => {
    const el = pane().querySelector<HTMLElement>("[data-new-divider]");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  // Two unread: the divider sits before the second message, not the first.
  expect(divider).toHaveTextContent("New");
  expect(divider.nextElementSibling).toHaveTextContent("dev says 2");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

test("when the unread are shorter than the pane it stays pinned at the bottom", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(900);
  await visit("/inbox?item=chat:dev");
  await waitFor(() => expect(pane().querySelector("[data-new-divider]")).not.toBeNull());
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

test("the pane reads the chat after the dwell, and a selection that moves cancels it", async () => {
  const app = await visit("/inbox?item=chat:dev");
  await within(pane()).findByText("dev says 3");
  expect(posts()).toHaveLength(0);
  await app.router.navigate({ to: "/inbox", search: { item: "chat:ops" } });
  await within(pane()).findByText("ops says 3");
  await waitFor(() => expect(posts()).toHaveLength(1), { timeout: 2000 });
  // Only ops was shown for the dwell: dev was passed over.
  expect(posts()[0]?.url).toBe("/api/inbox/read-from/ops");
  expect(posts()[0]?.body).toEqual({ upTo: at(3) });
});

test("the Chat page reads at once", async () => {
  renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(posts()).toHaveLength(1), { timeout: 250 });
  expect(posts()[0]?.body).toEqual({ upTo: at(3) });
});

test("a reload with ?item=chat:dev shows that chat even with nothing unread", async () => {
  chats = [];
  unread = { count: 0, byAgent: {} };
  fakeMatchMedia.installWidth(1280);
  renderApp("/inbox?item=chat:dev", alice);
  await screen.findByRole("region", { name: "Reading pane" });
  expect(await within(pane()).findByText("dev says 3")).toBeInTheDocument();
  const selected = await waitFor(() => {
    const el = listRow("dev");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(selected).not.toHaveTextContent("new");
  expect(posts()).toHaveLength(0);
});

test("the unread count coming back without a newer message (Undo of Mark all read) is not read again", async () => {
  const app = renderApp("/agents/dev/chat", alice);
  await waitFor(() => expect(posts()).toHaveLength(1));
  await waitFor(() =>
    expect(app.queryClient.getQueryData(["inbox-unread"])).toMatchObject({ count: 1 }),
  );
  act(() => app.queryClient.setQueryData(["inbox-unread"], { count: 3, byAgent: { dev: 2 } }));
  await new Promise((r) => setTimeout(r, 1300));
  expect(posts()).toHaveLength(1);
});

test("your message in the pane is the chat cache's own entry, keyed by its clientMessageId", async () => {
  api.on("POST /api/messages", () => new Promise<Response>(() => {}));
  const app = await visit("/inbox?item=chat:dev");
  await within(pane()).findByText("dev says 3");
  const box = await within(pane()).findByRole("combobox", { name: "Message to Dev agent" });
  await userEvent.type(box, "hello pane{Enter}");
  const block = (await within(pane()).findByText("hello pane")).closest(
    "[data-row]",
  ) as HTMLElement;
  const id = block.getAttribute("data-row") as string;
  expect(within(pane()).getAllByText("hello pane")).toHaveLength(1);
  const cached = app.queryClient.getQueryData<{
    pages: { entries: { clientMessageId?: string }[] }[];
  }>(chatQueryOptions("dev").queryKey);
  expect(
    cached?.pages.flatMap((p) => p.entries).filter((e) => e.clientMessageId === id),
  ).toHaveLength(1);
  fireEvent.keyDown(box, { key: "Escape" });
});
