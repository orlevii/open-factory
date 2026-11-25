import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
  vi.unstubAllGlobals();
});

const BODY =
  "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held.";
const base = {
  messageId: "m",
  kind: "notice",
  read: true,
  from: { kind: "factory", name: "factory" },
  to: "@alice",
  urgent: false,
  createdAt: new Date(2026, 10, 25, 13, 50).toISOString(),
};
const hold = {
  ...base,
  id: "hold1",
  about: "a",
  preview: BODY,
  notice: "loop_held",
  loopHold: {
    id: "h1",
    agents: [
      { slug: "a", status: "live" },
      { slug: "b", status: "live" },
    ],
    waiting: 4,
    sentOn: 0,
    resumedAt: null,
    resumedBy: null,
  },
  link: { kind: "session", agentSlug: "a" },
};
const cleanup = {
  ...base,
  id: "clean1",
  about: "dev-ab12",
  preview: "Cleaned up @dev-ab12's worktrees.",
  notice: "worktrees_kept",
  cleanup: {
    projects: [
      { project: "web", removed: true, deleted: [], kept: [{ branch: "feat/x", commits: 3 }] },
    ],
  },
  link: { kind: "session", agentSlug: "dev-ab12" },
};
const mention = {
  ...base,
  id: "men1",
  kind: "mention",
  from: { kind: "agent", name: "dev" },
  preview: "ping",
  task: { key: "T-7", title: "Seven" },
  link: { kind: "task", key: "T-7", commentId: "c1" },
};
const task = {
  key: "T-7",
  title: "Seven",
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "alice" },
  updatedAt: base.createdAt,
  body: "",
  createdAt: base.createdAt,
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
};

let items: unknown[];
let later: unknown;
let api: MockApi;
beforeEach(() => {
  items = [hold, mention, cleanup];
  later = undefined;
  api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0, byAgent: {} }),
    "GET /api/inbox/old1": () => json({ item: later }),
    "GET /api/agents/ada": () => json(detail()),
    "GET /api/tasks/T-7": () => json(task),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
});

const itemFetches = () => api.calls.filter((c) => /^\/api\/inbox\/(?!unread)/.test(c.url));

test("below 1024 a chat id goes to the Chat without fetching an item", async () => {
  fakeMatchMedia.installWidth(390);
  const app = renderApp("/inbox?item=chat:ada", alice);
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/agents/ada/chat"));
  expect(itemFetches()).toHaveLength(0);
});

test("below 1024 a hold opens full-width with Back and Resume; Back returns to the list", async () => {
  fakeMatchMedia.installWidth(390);
  const app = renderApp("/inbox?item=hold1", alice);
  expect(await screen.findByRole("button", { name: "Resume @a and @b" })).toBeInTheDocument();
  expect(screen.getByText(/exchanged 22 messages/)).toBeInTheDocument();
  expect(app.router.state.location.search).toEqual({ item: "hold1" });
  await userEvent.click(screen.getByRole("link", { name: "Back" }));
  await waitFor(() => expect(app.router.state.location.search).toEqual({}));
  expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Resume @a and @b" })).toBeNull();
});

test("below 1024 another kind's ?item= is replaced by its own target", async () => {
  fakeMatchMedia.installWidth(390);
  const app = renderApp("/inbox?item=men1", alice);
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-7"));
  expect(app.router.state.location.search).toEqual({ comment: "c1" });
  // replaced, not pushed: Back doesn't return to the interstitial
  expect(app.router.history.length).toBe(1);
});

test("an item outside the loaded pages is fetched and shown, never the list", async () => {
  later = { ...hold, id: "old1" };
  fakeMatchMedia.installWidth(390);
  renderApp("/inbox?item=old1", alice);
  expect(screen.queryByRole("link", { name: /From @?Factory/ })).toBeNull();
  expect(await screen.findByRole("button", { name: "Resume @a and @b" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
});

test.each([390, 1440])("a hold row links to /inbox?item= at %ipx", async (width) => {
  fakeMatchMedia.installWidth(width);
  renderApp("/inbox", alice);
  const row = await screen.findByRole("link", { name: /held/ });
  expect(row).toHaveAttribute("href", "/inbox?item=hold1");
});

test("below 1024 a cleanup notice opens full-width with Back and no composer", async () => {
  fakeMatchMedia.installWidth(390);
  const app = renderApp("/inbox?item=clean1", alice);
  expect(await screen.findByRole("button", { name: "Copy feat/x" })).toBeInTheDocument();
  expect(app.router.state.location.search).toEqual({ item: "clean1" });
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "Back" }));
  await waitFor(() => expect(app.router.state.location.search).toEqual({}));
  expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
});

test.each([390, 1440])("a cleanup row links to /inbox?item= at %ipx", async (width) => {
  fakeMatchMedia.installWidth(width);
  renderApp("/inbox", alice);
  const row = await screen.findByRole("link", { name: /about @dev-ab12/ });
  expect(row).toHaveAttribute("href", "/inbox?item=clean1");
});
