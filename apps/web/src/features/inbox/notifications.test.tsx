import type { ChatRow } from "@open-factory/shared";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import type { InboxItem } from "./api";
import {
  BLOCKED_NOTE,
  notificationTitle,
  notifyNew,
  useBrowserNotifications,
} from "./notifications";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: unknown) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: unknown) => void; onOpen?: () => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

type Opts = { body: string; tag: string; icon: string };
const shown: { title: string; opts: Opts; n: { onclick?: () => void; close: () => void } }[] = [];
function stubNotification(
  permission: NotificationPermission,
  request?: () => Promise<NotificationPermission>,
) {
  class N {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      const r = (await request?.()) ?? "granted";
      N.permission = r;
      return r;
    });
    onclick?: () => void;
    close = vi.fn();
    constructor(title: string, opts: Opts) {
      shown.push({ title, opts, n: this });
    }
  }
  vi.stubGlobal("Notification", N);
  return N;
}
const visibility = (v: "hidden" | "visible") =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });

beforeEach(() => {
  shown.length = 0;
  localStorage.clear();
  visibility("hidden");
});
afterEach(() => {
  vi.unstubAllGlobals();
  visibility("visible");
});

const item = (n: number, o: Record<string, unknown> = {}): InboxItem =>
  ({
    id: `i${n}`,
    messageId: `m${n}`,
    kind: "mention",
    read: false,
    from: { kind: "agent", name: "dev" },
    to: "@or",
    preview: `preview ${n}`,
    urgent: false,
    createdAt: "2026-11-19T14:32:00.000Z",
    task: { key: "T-42", title: "Plan" },
    link: { kind: "task", key: "T-42", commentId: "c1" },
    ...o,
  }) as InboxItem;

const none = { item() {}, chat() {} };
const chatRow = (over: Partial<ChatRow> = {}): ChatRow => ({
  agent: {
    slug: "ada",
    displayName: "Ada",
    template: "ada",
    avatarVersion: null,
    color: null,
    kind: "persistent",
    status: "idle",
    archivedAt: null,
  },
  unread: 3,
  latest: {
    messageId: "ada-m3",
    preview: "ship it",
    createdAt: "2026-11-19T14:32:00.000Z",
    urgent: false,
  },
  ...over,
});

test("titles by kind", () => {
  expect(notificationTitle(item(1))).toBe("@dev mentioned you on T-42");
  expect(
    notificationTitle(
      item(1, { kind: "task_event", fact: "done", task: { key: "T-40", title: "x" } }),
    ),
  ).toBe("T-40 is done");
  expect(
    notificationTitle(
      item(1, { kind: "task_event", fact: "cancelled", task: { key: "T-40", title: "x" } }),
    ),
  ).toBe("T-40 was cancelled");
  expect(
    notificationTitle(
      item(1, { kind: "notice", task: undefined, link: { kind: "session", agentSlug: "dev" } }),
    ),
  ).toBe("@dev messaged you");
  expect(
    notificationTitle(
      item(1, {
        kind: "notice",
        from: { kind: "factory", name: "factory" },
        about: "ops",
        task: undefined,
      }),
    ),
  ).toBe("Factory about @ops");
});

test("credential titles: Credential expiring, then Credential expired once past", () => {
  const cred = (expiresAt: string) =>
    item(1, {
      kind: "credential",
      from: { kind: "factory", name: "factory" },
      task: undefined,
      credential: { name: "work", expiresAt, current: true },
      link: { kind: "credential", name: "work" },
    });
  expect(notificationTitle(cred("2099-01-01T00:00:00Z"))).toBe("Credential expiring");
  expect(notificationTitle(cred("2020-01-01T00:00:00Z"))).toBe("Credential expired");
});

test("an expired credential title does not depend on current", () => {
  const signedInAgain = item(1, {
    kind: "credential",
    from: { kind: "factory", name: "factory" },
    task: undefined,
    credential: { name: "work", expiresAt: "2020-01-01T00:00:00Z", current: false },
    link: { kind: "credential", name: "work" },
  });
  expect(notificationTitle(signedInAgain)).toBe("Credential expired");
});

test("a credential notification's click opens the credentials deep link", async () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  vi.spyOn(window, "focus").mockImplementation(() => {});
  let items: InboxItem[] = [];
  mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }),
    "POST /api/inbox/i1/read": () => json({ ok: true }),
    "GET /api/credentials": () => json({ credentials: [] }),
  });
  const app = renderApp("/", alice);
  await screen.findByRole("button", { name: /Alice/ });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  items = [
    item(1, {
      kind: "credential",
      from: { kind: "factory", name: "factory" },
      task: undefined,
      credential: { name: "work", expiresAt: "2099-01-01T00:00:00Z", current: true },
      link: { kind: "credential", name: "work" },
    }),
  ];
  act(() => ws.push({ type: "inbox_changed" }));
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(shown[0]?.title).toBe("Credential expiring");
  act(() => shown[0]?.n.onclick?.());
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/settings/credentials"));
  expect(app.router.state.location.search).toEqual({ credential: "work" });
});

test("unsupported browsers: the hook says so", () => {
  vi.stubGlobal("Notification", undefined);
  const { result } = renderHook(() => useBrowserNotifications());
  expect(result.current.supported).toBe(false);
  expect(result.current.enabled).toBe(false);
});

test("turning on asks for permission from the click and stores the choice", async () => {
  const N = stubNotification("default");
  const { result } = renderHook(() => useBrowserNotifications());
  expect(result.current.enabled).toBe(false);
  await act(() => result.current.toggle());
  expect(N.requestPermission).toHaveBeenCalledOnce();
  expect(result.current.enabled).toBe(true);
  expect(localStorage.getItem("of-notifications")).toBe("1");
  await act(() => result.current.toggle());
  expect(result.current.enabled).toBe(false);
});

test("denied or dismissed stays off and says blocked", async () => {
  stubNotification("default", async () => "denied");
  const { result } = renderHook(() => useBrowserNotifications());
  await act(() => result.current.toggle());
  expect(result.current.enabled).toBe(false);
  expect(result.current.blocked).toBe(true);
  expect(localStorage.getItem("of-notifications")).toBeNull();
});

test("a permission revoked later reads as off", () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("denied");
  const { result } = renderHook(() => useBrowserNotifications());
  expect(result.current.enabled).toBe(false);
});

test("a hidden tab shows one plain-text notification per new unread item: tag, icon and a 120-character body", () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  const seen = new Set<string>(["old"]);
  const long = `${"x".repeat(200)}\n<b>y</b>`;
  notifyNew({ items: [item(1, { preview: long }), item(2, { read: true }), item(3)] }, seen, none);
  expect(shown).toHaveLength(2);
  expect(shown[0]?.title).toBe("@dev mentioned you on T-42");
  expect(shown[0]?.opts.tag).toBe("i1");
  expect(shown[0]?.opts.icon).toBe("/favicon.svg");
  expect(shown[0]?.opts.body).toHaveLength(120);
  expect(shown[0]?.opts.body.endsWith("…")).toBe(true);
  // Everything handed over is now seen: the same items never notify twice.
  notifyNew({ items: [item(1)] }, seen, none);
  expect(shown).toHaveLength(2);
});

test("a visible tab, an off switch and an already seen item show nothing", () => {
  stubNotification("granted");
  localStorage.setItem("of-notifications", "1");
  visibility("visible");
  notifyNew({ items: [item(1)] }, new Set(), none);
  visibility("hidden");
  notifyNew({ items: [item(2)] }, new Set(["i2"]), none);
  localStorage.setItem("of-notifications", "0");
  notifyNew({ items: [item(3)] }, new Set(), none);
  expect(shown).toHaveLength(0);
});

test("clicking focuses the window, closes it and opens the item (our own deep link)", () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
  const open = vi.fn();
  notifyNew({ items: [item(1)] }, new Set(), { ...none, item: open });
  shown[0]?.n.onclick?.();
  expect(focus).toHaveBeenCalled();
  expect(shown[0]?.n.close).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }));
});

test("the user menu has the switch under Theme; blocked keeps the menu open with the note", async () => {
  stubNotification("default", async () => "denied");
  mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }),
  });
  renderApp("/", alice);
  await userEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  const sw = await screen.findByRole("menuitemcheckbox", { name: "Browser notifications" });
  await userEvent.click(sw);
  expect(await screen.findByText(BLOCKED_NOTE)).toBeInTheDocument();
  expect(
    screen.getByRole("menuitemcheckbox", { name: "Browser notifications" }),
  ).toBeInTheDocument();
  expect(sw).toHaveAttribute("aria-checked", "false");
});

test("the item is absent when the browser has no Notification API", async () => {
  vi.stubGlobal("Notification", undefined);
  mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": () => json({ chats: [], items: [], nextCursor: null }),
  });
  renderApp("/", alice);
  await userEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  await screen.findByRole("menuitemradio", { name: "Light" });
  expect(screen.queryByRole("menuitemcheckbox", { name: "Browser notifications" })).toBeNull();
});

test("a hidden tab notifies once per new chat message: 'Ada · 3 new', tagged with the newest message", () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  const seen = new Set<string>();
  notifyNew({ items: [], chats: [chatRow()] }, seen, none);
  expect(shown).toHaveLength(1);
  expect(shown[0]?.title).toBe("Ada · 3 new");
  expect(shown[0]?.opts).toMatchObject({ tag: "ada-m3", body: "ship it" });
  notifyNew({ items: [], chats: [chatRow()] }, seen, none);
  expect(shown).toHaveLength(1);
  // A newer message is a new notification.
  notifyNew(
    {
      items: [],
      chats: [
        chatRow({
          unread: 4,
          latest: {
            messageId: "ada-m4",
            preview: "and tests",
            createdAt: "2026-11-19T14:40:00.000Z",
            urgent: false,
          },
        }),
      ],
    },
    seen,
    none,
  );
  expect(shown.map((n) => n.title)).toEqual(["Ada · 3 new", "Ada · 4 new"]);
});

test("clicking a chat notification opens that chat on its newest message", async () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  vi.spyOn(window, "focus").mockImplementation(() => {});
  let chats: ChatRow[] = [];
  mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": () => json({ chats, items: [], nextCursor: null }),
    "GET /api/agents/ada/chat?": () =>
      json({ entries: [], nextCursor: null, newerCursor: null, working: null }),
  });
  const app = renderApp("/", alice);
  await screen.findByRole("button", { name: /Alice/ });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  chats = [chatRow()];
  act(() => ws.push({ type: "inbox_changed" }));
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(shown[0]?.title).toBe("Ada · 3 new");
  act(() => shown[0]?.n.onclick?.());
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/agents/ada/chat"));
  expect(app.router.state.location.search).toEqual({ message: "ada-m3" });
});

test("member updates in the inbox never notify, even in a hidden tab", async () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
  let updates: ChatRow[] = [];
  mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": () => json({ chats: [], updates, items: [], nextCursor: null }),
  });
  renderApp("/", alice);
  await screen.findByRole("button", { name: /Alice/ });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  updates = [chatRow({ unread: 2 })];
  act(() => ws.push({ type: "inbox_changed" }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(shown).toEqual([]);
});
