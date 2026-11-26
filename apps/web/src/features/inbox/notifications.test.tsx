import type { ChatRow } from "@open-factory/shared";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import type { InboxItem } from "./api";
import { type Burst, burstsOf } from "./notification-copy";
import { BLOCKED_NOTE, Notifier, resetNotifier, useBrowserNotifications } from "./notifications";

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
type Shown = { title: string; opts: Opts; n: FakeN };
type FakeN = { onclick?: () => void; onclose?: () => void; close: ReturnType<typeof vi.fn> };
const shown: Shown[] = [];
const PREVIEW = "SECRET-PREVIEW-MARKER-7431";
function stubNotification(
  permission: NotificationPermission,
  request?: () => Promise<NotificationPermission>,
  throws = false,
) {
  class N {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      const r = (await request?.()) ?? "granted";
      N.permission = r;
      return r;
    });
    onclick?: () => void;
    onclose?: () => void;
    close = vi.fn();
    constructor(title: string, opts: Opts) {
      if (throws) throw new TypeError("Illegal constructor");
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
  resetNotifier();
  vi.unstubAllGlobals();
  visibility("visible");
});

const chatRow = (
  over: { handle?: string; name?: string; unread?: number; first?: string; latest?: string } = {},
): ChatRow => ({
  agent: {
    ref: refFor(over.handle ?? "ada"),
    handle: over.handle ?? "ada",
    displayName: over.name ?? "Ada",
    template: "ada",
    avatarVersion: null,
    color: null,
    kind: "persistent",
    status: "idle",
    archivedAt: null,
  },
  unread: over.unread ?? 1,
  firstUnreadId: over.first ?? "ada-m1",
  latest: {
    messageId: over.latest ?? "ada-m1",
    preview: PREVIEW,
    createdAt: "2026-11-19T14:32:00.000Z",
    urgent: false,
  },
});

let n = 0;
const item = (o: Record<string, unknown> = {}): InboxItem => {
  n += 1;
  return {
    id: `i${n}`,
    messageId: `m${n}`,
    kind: "mention",
    read: false,
    from: { kind: "human", ref: refFor("alice"), handle: "alice" },
    to: "@or",
    preview: PREVIEW,
    urgent: false,
    createdAt: `2026-11-19T14:${String(n).padStart(2, "0")}:00.000Z`,
    task: { key: "T-42", title: "Plan" },
    link: { kind: "task", key: "T-42", commentId: `c${n}` },
    ...o,
  } as InboxItem;
};
const errored = (about: string) =>
  item({
    kind: "notice",
    notice: "agent_errored",
    about,
    from: { kind: "factory" },
    task: undefined,
    link: { kind: "session", agentRef: refFor(about) },
  });
const credential = (name: string) =>
  item({
    kind: "credential",
    from: { kind: "factory" },
    task: undefined,
    credential: { name, expiresAt: "2099-01-01T00:00:00Z", current: true },
    link: { kind: "credential", name },
  });

type Page = { chats?: ChatRow[]; items?: InboxItem[] };
const bursts = (p: Page): Burst[] => burstsOf({ chats: p.chats ?? [], items: p.items ?? [] });
const on = () => {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted");
};

// ---- Notifier ----

test("a visible tab shows nothing; a hidden one shows one notification with the burst's title, body and tag, never a preview", () => {
  on();
  const failed = errored("dev");
  const page = { chats: [chatRow()], items: [failed] };
  new Notifier(() => {}).update(bursts(page), true);
  expect(shown).toHaveLength(0);
  new Notifier(() => {}).update(bursts(page), false);
  expect(shown.map((s) => [s.title, s.opts.body, s.opts.tag])).toEqual([
    ["Ada", "1 new message", `chat:${refFor("ada")}:ada-m1`],
    ["@dev", "Hit an error", `error:dev:${failed.id}`],
  ]);
  for (const s of shown) {
    expect(s.opts.body).not.toContain(PREVIEW);
    expect(s.opts.icon).toBe("/favicon.svg");
  }
});

test("a second message while the chat is unread re-uses the tag (silent replacement) and says 2 new messages", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.update(bursts({ chats: [chatRow()] }), false);
  notifier.update(bursts({ chats: [chatRow({ unread: 2, latest: "ada-m2" })] }), false);
  expect(shown).toHaveLength(2);
  expect(shown[1]?.opts).toMatchObject({ tag: shown[0]?.opts.tag, body: "2 new messages" });
  // Nothing about the replacement is loud: no `renotify`.
  expect(shown[1]?.opts).not.toHaveProperty("renotify");
});

test("a chat that was read closes its notification; the next message is a new tag", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.update(bursts({ chats: [chatRow()] }), false);
  notifier.update(bursts({}), false);
  expect(shown[0]?.n.close).toHaveBeenCalledOnce();
  notifier.update(bursts({ chats: [chatRow({ first: "ada-m5", latest: "ada-m5" })] }), false);
  expect(shown).toHaveLength(2);
  expect(shown[1]?.opts.tag).toBe(`chat:${refFor("ada")}:ada-m5`);
});

test("a chat partly read elsewhere closes the old notification and shows nothing new", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.update(bursts({ chats: [chatRow({ unread: 3, latest: "ada-m3" })] }), false);
  notifier.update(
    bursts({ chats: [chatRow({ unread: 1, first: "ada-m3", latest: "ada-m3" })] }),
    false,
  );
  expect(shown).toHaveLength(1);
  expect(shown[0]?.n.close).toHaveBeenCalledOnce();
});

test("a burst that is only baselined never notifies, even once the tab is hidden and it is refreshed", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.baseline(bursts({ chats: [chatRow()] }));
  notifier.update(bursts({ chats: [chatRow()] }), false);
  expect(shown).toHaveLength(0);
});

test("reading a burst's newest item elsewhere does not re-notify a burst already counted", () => {
  on();
  const notifier = new Notifier(() => {});
  const [a, b] = [item(), item()];
  notifier.baseline(bursts({ items: [a, b] }));
  notifier.update(bursts({ items: [a] }), false);
  expect(shown).toHaveLength(0);
});

test("a throwing constructor marks notifications unsupported and the hook reports it", () => {
  stubNotification("granted", undefined, true);
  localStorage.setItem("of-notifications", "1");
  const { result } = renderHook(() => useBrowserNotifications());
  expect(result.current.supported).toBe(true);
  const notifier = new Notifier(() => {});
  act(() => notifier.update(bursts({ chats: [chatRow()] }), false));
  expect(result.current.supported).toBe(false);
  expect(result.current.enabled).toBe(false);
});

test("reset closes every shown notification and forgets what was seen", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.update(bursts({ chats: [chatRow()] }), false);
  notifier.reset();
  expect(shown[0]?.n.close).toHaveBeenCalledOnce();
  // Forgotten: the same unread chat is new again.
  notifier.update(bursts({ chats: [chatRow()] }), false);
  expect(shown).toHaveLength(2);
});

test("a notification the user dismissed is dropped, so the next one for the key is not mistaken for a replacement", () => {
  on();
  const notifier = new Notifier(() => {});
  notifier.update(bursts({ chats: [chatRow()] }), false);
  shown[0]?.n.onclose?.();
  // The burst is gone (read) after the dismissal: nothing is left to close.
  notifier.update(bursts({}), false);
  expect(shown[0]?.n.close).not.toHaveBeenCalled();
});

test("a resolved hold closes its notification", () => {
  on();
  const notifier = new Notifier(() => {});
  const hold = (resumedAt: string | null) =>
    item({
      kind: "notice",
      notice: "loop_held",
      from: { kind: "factory" },
      task: undefined,
      link: { kind: "session", agentRef: refFor("a") },
      loopHold: {
        id: "h1",
        agents: [
          { ref: refFor("a"), handle: "a", status: "live" },
          { ref: refFor("b"), handle: "b", status: "live" },
        ],
        waiting: 2,
        sentOn: 1,
        resumedAt,
        resumedBy: null,
      },
    });
  notifier.update(bursts({ items: [hold(null)] }), false);
  expect(shown).toHaveLength(1);
  notifier.update(bursts({ items: [hold("2026-11-25T10:00:00.000Z")] }), false);
  expect(shown[0]?.n.close).toHaveBeenCalledOnce();
  expect(shown).toHaveLength(1);
});

test("a mention from a human titles the notification with their real @handle", () => {
  on();
  new Notifier(() => {}).update(bursts({ items: [item()] }), false);
  expect(shown[0]?.title).toBe("@alice");
  expect(shown[0]?.opts.body).toBe("Mentioned you on T-42");
});

// ---- the app: fetch, trailing fetch, switch, click ----

const notifyCalls = (api: { calls: { method: string; url: string }[] }) =>
  api.calls.filter((c) => c.method === "GET" && c.url.includes("notify=true"));

/** Mounts the app with the switch on; `page` is what the notify query answers, changed by the test. */
async function boot(
  initial: Page,
  gate?: (call: number) => Promise<void> | undefined,
  throws = false,
) {
  localStorage.setItem("of-notifications", "1");
  stubNotification("granted", undefined, throws);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  const state = { page: initial };
  const api = mockApi({
    "GET /api/inbox/unread-count": () => json({ count: 0 }),
    "GET /api/inbox?": async (_b, url) => {
      if (!url.includes("notify=true")) return json({ chats: [], items: [], nextCursor: null });
      const snapshot = {
        chats: state.page.chats ?? [],
        items: state.page.items ?? [],
        nextCursor: null,
      };
      await gate?.(notifyCalls(api).length);
      return json(snapshot);
    },
    "POST /api/inbox/": () => json({ ok: true }),
    [`GET /api/agents/${refFor("ada")}/chat?`]: () =>
      json({ entries: [], nextCursor: null, newerCursor: null, working: null }),
    "GET /api/credentials": () => json({ credentials: [] }),
  });
  const app = renderApp("/", alice);
  await screen.findByRole("button", { name: /Alice/ });
  await waitFor(() => expect(notifyCalls(api)).toHaveLength(1));
  return { api, app, state };
}
/** A frame: the next change reaches the tab and the notify query is asked again. */
const frame = () => act(async () => ws.push({ type: "inbox_changed" }));

test("what is unread at load never notifies; a later chat message does", async () => {
  const { api, state } = await boot({ chats: [chatRow()] });
  // The baseline fetch is in flight; this frame becomes its trailing fetch.
  state.page = {
    chats: [chatRow(), chatRow({ handle: "bo", name: "Bo", first: "bo-1", latest: "bo-1" })],
  };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(notifyCalls(api)).toHaveLength(2);
  expect(shown[0]?.title).toBe("Bo");
});

test("six unread mentions over two tasks, beyond one inbox page, keep both notifications open", async () => {
  const mentions = (key: string, k: number) =>
    Array.from({ length: k }, () =>
      item({ task: { key, title: key }, link: { kind: "task", key } }),
    );
  const { api, state } = await boot({});
  state.page = { items: [...mentions("T-1", 3), ...mentions("T-2", 3)] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(2));
  expect(notifyCalls(api)[1]?.url).toBe("/api/inbox?unread=true&notify=true");
  // Another frame with the same unread items plus a new chat: the chat shows, the mentions stay.
  state.page = { ...state.page, chats: [chatRow()] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(3));
  expect(shown[0]?.n.close).not.toHaveBeenCalled();
  expect(shown[1]?.n.close).not.toHaveBeenCalled();
});

test("task events and other facts never notify", async () => {
  const { state } = await boot({});
  state.page = {
    items: [
      item({ kind: "task_event", fact: "done" }),
      item({
        kind: "notice",
        notice: "factory_restarted",
        from: { kind: "factory" },
        task: undefined,
        link: { kind: "session", agentRef: refFor("dev") },
      }),
      credential("work"),
    ],
  };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(shown[0]?.title).toBe('Credential "work"');
});

test("two frames during one fetch make exactly one trailing fetch", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const { api, state } = await boot({}, (call) => (call === 1 ? held : undefined));
  state.page = { chats: [chatRow()] };
  await frame();
  await frame();
  expect(notifyCalls(api)).toHaveLength(1);
  await act(async () => release());
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(notifyCalls(api)).toHaveLength(2);
});

test("a response that arrives after sign-out is ignored", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const { api, state } = await boot({}, (call) => (call === 1 ? held : undefined));
  resetNotifier();
  state.page = { chats: [chatRow()] };
  await act(async () => release());
  // Reset forgot the baseline; the late reply must not be applied as one or as news.
  await frame();
  await waitFor(() => expect(notifyCalls(api)).toHaveLength(2));
  await frame();
  await waitFor(() => expect(notifyCalls(api)).toHaveLength(3));
  expect(shown).toHaveLength(0);
});

test("turning the switch off closes this tab's notifications", async () => {
  const { state } = await boot({});
  state.page = { chats: [chatRow()] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  await userEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Browser notifications" }),
  );
  await waitFor(() => expect(shown[0]?.n.close).toHaveBeenCalledOnce());
});

test("a constructor that throws removes the switch from the user menu", async () => {
  const { state } = await boot({}, undefined, true);
  await userEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Browser notifications" }),
  ).toBeInTheDocument();
  state.page = { chats: [chatRow()] };
  await frame();
  await waitFor(() =>
    expect(screen.queryByRole("menuitemcheckbox", { name: "Browser notifications" })).toBeNull(),
  );
});

test("clicking a chat notification focuses, opens the chat at the first unread message and marks nothing read", async () => {
  const { api, app, state } = await boot({});
  state.page = { chats: [chatRow({ unread: 3, first: "ada-m1", latest: "ada-m3" })] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  act(() => shown[0]?.n.onclick?.());
  expect(window.focus).toHaveBeenCalled();
  expect(shown[0]?.n.close).toHaveBeenCalled();
  await waitFor(() =>
    expect(app.router.state.location.pathname).toBe(`/agents/${refFor("ada")}/chat`),
  );
  expect(app.router.state.location.search).toEqual({ message: "ada-m1" });
  expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
});

test("clicking a mention notification opens the task at the first unread comment and marks its items read", async () => {
  const a = item({ link: { kind: "task", key: "T-42", commentId: "c-first" } });
  const b = item();
  const { api, app, state } = await boot({});
  state.page = { items: [a, b] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  act(() => shown[0]?.n.onclick?.());
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-42"));
  expect(app.router.state.location.search).toEqual({ comment: "c-first" });
  await waitFor(() =>
    expect(
      api.calls
        .filter((c) => c.method === "POST")
        .map((c) => c.url)
        .sort(),
    ).toEqual([`/api/inbox/${a.id}/read`, `/api/inbox/${b.id}/read`].sort()),
  );
});

test("clicking an error notification opens the agent's session and marks the item read", async () => {
  const e = errored("dev");
  const { api, app, state } = await boot({});
  state.page = { items: [e] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  act(() => shown[0]?.n.onclick?.());
  await waitFor(() =>
    expect(app.router.state.location.pathname).toBe(`/agents/${refFor("dev")}/session`),
  );
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "POST" && c.url === `/api/inbox/${e.id}/read`)).toBe(
      true,
    ),
  );
});

test("clicking a credential notification opens the credentials pane on it and marks the item read", async () => {
  const c = credential("work");
  const { api, app, state } = await boot({});
  state.page = { items: [c] };
  await frame();
  await waitFor(() => expect(shown).toHaveLength(1));
  act(() => shown[0]?.n.onclick?.());
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/settings/credentials"));
  expect(app.router.state.location.search).toEqual({ credential: "work" });
  await waitFor(() =>
    expect(api.calls.some((x) => x.method === "POST" && x.url === `/api/inbox/${c.id}/read`)).toBe(
      true,
    ),
  );
});

// ---- the switch ----

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
