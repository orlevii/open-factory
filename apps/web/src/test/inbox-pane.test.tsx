import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inboxItemOptions } from "@/features/inbox/api";
import { INBOX_DWELL_MS } from "@/lib/timing";
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
  vi.useRealTimers();
  window.matchMedia = original;
  vi.unstubAllGlobals();
});

const at = (m: number) => new Date(2026, 10, 19, 14, m).toISOString();
const item = (n: number, o: Record<string, unknown> = {}) => ({
  id: `i${n}`,
  messageId: `m${n}`,
  kind: "notice",
  read: false,
  from: { kind: "agent", name: "dev" },
  to: "@bob",
  preview: `preview ${n}`,
  urgent: false,
  createdAt: at(50 - n),
  link: { kind: "session", agentSlug: "dev", seq: 40 + n },
  ...o,
});
const items = [
  item(1),
  item(2),
  item(3, {
    kind: "mention",
    to: "@alice",
    task: { key: "T-7", title: "Seven" },
    link: { kind: "task", key: "T-7", commentId: "c1" },
  }),
  item(4),
  item(5),
];

let api: MockApi;
beforeEach(() => {
  api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 5, byAgent: {} }),
    // The pane loads what it shows; unanswered (404), an errored query refetches for every new
    // observer, which isn't what these tests are about.
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/tasks/T-7": () =>
      json({
        key: "T-7",
        title: "Seven",
        status: "open",
        assignee: null,
        blockedBy: [],
        createdBy: { kind: "user", handle: "alice" },
        updatedAt: at(0),
        body: "",
        createdAt: at(0),
        dependsOn: [],
        blocks: [],
        links: [],
        activity: [],
        usage: null,
      }),
    // The agents list loads once (sidebar, chips).
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  for (const i of items) api.on(`POST /api/inbox/${i.id}/read`, () => json({ ok: true }));
});

const reads = () =>
  api.calls.filter((c) => c.method === "POST" && /\/api\/inbox\/i\d\/read$/.test(c.url));
const gets = (part: string) =>
  api.calls.filter((c) => c.method === "GET" && c.url.includes(part)).length;
const row = (id: string) => document.querySelector<HTMLElement>(`a[data-inbox-id="${id}"]`);

async function visit(width: number, path = "/inbox") {
  fakeMatchMedia.installWidth(width);
  const app = renderApp(path, alice);
  await waitFor(() => expect(row("i1")).not.toBeNull());
  return app;
}
const search = (app: Awaited<ReturnType<typeof visit>>) =>
  app.router.state.location.search as { item?: string };

test("≥1024 plain click selects: push ?item=, marks read once, row aria-current", async () => {
  const app = await visit(1280);
  expect(screen.getByText("No item selected.")).toBeInTheDocument();
  const before = app.router.history.length;
  fireEvent.click(row("i2") as HTMLElement);
  await waitFor(() => expect(search(app).item).toBe("i2"));
  expect(app.router.state.location.pathname).toBe("/inbox");
  expect(app.router.history.length).toBe(before + 1);
  expect(row("i2")).toHaveAttribute("aria-current", "true");
  expect(row("i1")).not.toHaveAttribute("aria-current");
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i2/read"]));
  // The pane's header comes from the row at once.
  const pane = screen.getByRole("region", { name: "Reading pane" });
  expect(within(pane).getByRole("link", { name: "Open in session" })).toHaveAttribute(
    "href",
    "/agents/dev/session?event=42",
  );
  expect(screen.queryByText("No item selected.")).toBeNull();
});

test("modifier-click and middle-click don't select (target opens), and mark read as today", async () => {
  const app = await visit(1280);
  fireEvent.click(row("i1") as HTMLElement, { metaKey: true });
  fireEvent(
    row("i2") as HTMLElement,
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  await waitFor(() => expect(reads()).toHaveLength(2));
  expect(search(app).item).toBeUndefined();
  expect(row("i1")).not.toHaveAttribute("aria-current");
  expect(row("i2")).not.toHaveAttribute("aria-current");
});

test("j/k move the selection with replace; read only after INBOX_DWELL_MS", async () => {
  const app = await visit(1280, "/inbox?item=i2");
  const r2 = row("i2") as HTMLElement;
  r2.focus();
  const before = app.router.history.length;
  vi.useFakeTimers();
  fireEvent.keyDown(r2, { key: "k" });
  await act(async () => vi.advanceTimersByTime(100));
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
  await act(async () => vi.advanceTimersByTime(100));
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
  await act(async () => vi.advanceTimersByTime(100));
  expect(search(app).item).toBe("i3");
  expect(app.router.history.length).toBe(before);
  expect(row("i3")).toHaveAttribute("aria-current", "true");
  expect(reads()).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i3/read"]);
});

test("a key-repeat sweep marks nothing read", async () => {
  const app = await visit(1280, "/inbox?item=i1");
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  for (let n = 0; n < 4; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(30));
  }
  expect(search(app).item).toBe("i5");
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS - 200));
  expect(reads()).toHaveLength(0);
  // Only the item the sweep rests on is read, once it has been shown for the dwell.
  await act(async () => vi.advanceTimersByTime(200));
  expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i5/read"]);
});

test("↓/↑ move focus only (no ?item= change)", async () => {
  const app = await visit(1280, "/inbox?item=i1");
  (row("i1") as HTMLElement).focus();
  fireEvent.keyDown(row("i1") as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(row("i2"));
  fireEvent.keyDown(row("i2") as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(row("i3"));
  await new Promise((r) => setTimeout(r, INBOX_DWELL_MS + 50));
  expect(search(app).item).toBe("i1");
  expect(row("i1")).toHaveAttribute("aria-current", "true");
  // Only the shown item is read (after the dwell); the rows focus passed are not.
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i1/read"]));
});

test("Enter selects (push) and marks read at once", async () => {
  const app = await visit(1280);
  const before = app.router.history.length;
  (row("i4") as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(search(app).item).toBe("i4"));
  expect(app.router.history.length).toBe(before + 1);
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i4/read"]));
});

test("Space on a focused row selects it like Enter", async () => {
  const app = await visit(1280);
  (row("i5") as HTMLElement).focus();
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  fireEvent(row("i5") as HTMLElement, space);
  expect(space.defaultPrevented).toBe(true);
  await waitFor(() => expect(search(app).item).toBe("i5"));
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i5/read"]));
});

test("<1024 rows navigate; ?item= is dropped", async () => {
  api.on("GET /api/agents/dev", () => json({ error: { code: "not_found", message: "x" } }, 404));
  const app = await visit(800, "/inbox?item=i2");
  await waitFor(() => expect(search(app).item).toBeUndefined());
  expect(screen.queryByRole("region", { name: "Reading pane" })).toBeNull();
  expect(row("i2")).not.toHaveAttribute("aria-current");
  fireEvent.click(row("i1") as HTMLElement);
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/agents/dev/session"));
});

test("neighbours' pane data are prefetched on selection", async () => {
  await visit(1280);
  fireEvent.click(row("i2") as HTMLElement);
  // i3 is a mention: its task is warmed; the notices beside it have nothing to fetch.
  await waitFor(() => expect(gets("/api/tasks/T-7")).toBe(1));
  expect(gets("/events")).toBe(0);
});

test("a j/k sweep prefetches only once the selection rests", async () => {
  await visit(1280, "/inbox?item=i1");
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTime(500));
  const start = api.calls.length;
  for (let n = 0; n < 3; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
    await act(async () => vi.advanceTimersByTime(50));
  }
  // Nothing for a neighbour while the selection moves.
  expect(api.calls.slice(start).filter((c) => c.method === "GET")).toEqual([]);
  await act(async () => vi.advanceTimersByTime(200));
  // Resting on i4: its neighbour i3 is the mention (task T-7).
  expect(api.calls.slice(start).map((c) => c.url)).toContain("/api/tasks/T-7");
});

test("a j/k sweep loads the pane's body only for the item it rests on", async () => {
  const app = await visit(1280, "/inbox?item=i1");
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTime(500));
  const start = api.calls.length;
  const bodyGets = (part: string) =>
    api.calls.slice(start).filter((c) => c.method === "GET" && c.url.includes(part)).length;
  for (let n = 0; n < 2; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(50));
  }
  expect(search(app).item).toBe("i3");
  // The header follows the row at once; the task (i3) isn't requested while the selection moves.
  const pane = screen.getByRole("region", { name: "Reading pane" });
  expect(within(pane).getByRole("link", { name: "Open task" })).toHaveAttribute(
    "href",
    "/tasks/T-7?comment=c1",
  );
  expect(bodyGets("/api/tasks/T-7")).toBe(0);
  await act(async () => vi.advanceTimersByTime(200));
  expect(bodyGets("/api/tasks/T-7")).toBeGreaterThan(0);
});

test("a message row's context line hides the recipient when it is the viewer", async () => {
  api.on("GET /api/inbox?", () =>
    json({ chats: [], items: [item(1, { to: "@alice" }), item(2)], nextCursor: null }),
  );
  await visit(1280);
  expect(within(row("i2") as HTMLElement).getByText("→ @bob")).toBeInTheDocument();
  expect(within(row("i1") as HTMLElement).queryByText("→ @alice")).toBeNull();
});

test("a dwell is cancelled by a click elsewhere and on unmount; a pending prefetch too", async () => {
  const app = await visit(1280, "/inbox?item=i1");
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  fireEvent.keyDown(row("i1") as HTMLElement, { key: "j" });
  await act(async () => vi.advanceTimersByTime(100));
  fireEvent.click(row("i4") as HTMLElement);
  // The pane moves to i4 once the navigation commits; i2's dwell ends with it.
  await act(async () => vi.advanceTimersByTime(100));
  expect(search(app).item).toBe("i4");
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 2));
  expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i4/read"]);

  fireEvent.keyDown(row("i4") as HTMLElement, { key: "j" });
  await act(async () => vi.advanceTimersByTime(50));
  const start = api.calls.length;
  app.unmount();
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 2));
  expect(api.calls.slice(start)).toEqual([]);
});

test("Back during a dwell cancels it", async () => {
  const app = await visit(1280);
  fireEvent.click(row("i1") as HTMLElement);
  await waitFor(() => expect(search(app).item).toBe("i1"));
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  fireEvent.keyDown(row("i1") as HTMLElement, { key: "j" });
  await act(async () => vi.advanceTimersByTime(100));
  expect(search(app).item).toBe("i2");
  await act(async () => app.router.history.back());
  await act(async () => vi.advanceTimersByTime(100));
  expect(search(app).item).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 2));
  expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i1/read"]);
});

test("a deep-linked unread item is read once it has been shown for INBOX_DWELL_MS", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await visit(1280, "/inbox?item=i2");
  await waitFor(() => expect(row("i2")).toHaveAttribute("aria-current", "true"));
  expect(reads()).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i2/read"]));
});

test("an item Back restores is read after the dwell; one shown for less is not", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const app = await visit(1280);
  await act(async () => app.router.navigate({ to: "/inbox", search: { item: "i3" } }));
  await act(async () => app.router.navigate({ to: "/inbox", search: { item: "i4" } }));
  expect(search(app).item).toBe("i4");
  await act(async () => app.router.history.back());
  await waitFor(() => expect(search(app).item).toBe("i3"));
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i3/read"]));
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 2));
  expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i3/read"]);
});

const fail = () => json({ error: { code: "x", message: "x" } }, 500);
const readsOf = (id: string) => reads().filter((c) => c.url === `/api/inbox/${id}/read`).length;

test("a failed dwell read is not retried while the item stays shown", async () => {
  api.on("POST /api/inbox/i2/read", fail);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await visit(1280, "/inbox?item=i2");
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  await waitFor(() => expect(readsOf("i2")).toBe(1));
  // The rollback turns the row unread again; the dwell doesn't re-arm.
  await waitFor(() => expect(row("i2")?.getAttribute("aria-label")).toMatch(/^Unread/));
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 3));
  expect(readsOf("i2")).toBe(1);
});

test("a failed dwell read restores the pane's own copy of an item outside the loaded pages", async () => {
  const i9 = item(9);
  api.on("GET /api/inbox/i9", () => json({ item: i9 }));
  api.on("POST /api/inbox/i9/read", fail);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const app = await visit(1280, "/inbox?item=i9");
  const copy = () => app.queryClient.getQueryData(inboxItemOptions("i9").queryKey);
  await waitFor(() => expect(copy()).toBeDefined());
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  await waitFor(() => expect(readsOf("i9")).toBe(1));
  await waitFor(() => expect(copy()?.read).toBe(false));
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 3));
  expect(readsOf("i9")).toBe(1);
});

test("Undo of Mark all read leaves the shown item unread: the dwell doesn't read it again", async () => {
  let server = items.map((i) => ({ ...i }));
  api.on("GET /api/inbox?", () => json({ chats: [], items: server, nextCursor: null }));
  api.on("POST /api/inbox/read-all", () => {
    server = server.map((i) => ({ ...i, read: true }));
    return json({ readAt: "2026-11-19T15:00:00.123Z", count: 5 });
  });
  api.on("POST /api/inbox/read-all/undo", () => {
    server = server.map((i) => ({ ...i, read: false }));
    return json({ count: 5 });
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await visit(1280, "/inbox?item=i2");
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS));
  await waitFor(() => expect(readsOf("i2")).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(row("i2")?.getAttribute("aria-label")).toMatch(/^Unread/));
  await act(async () => vi.advanceTimersByTime(INBOX_DWELL_MS * 2));
  expect(readsOf("i2")).toBe(1);
  expect(row("i2")?.getAttribute("aria-label")).toMatch(/^Unread/);
});

test("<1024 a keyboard sweep through the rows fetches no task or agent; hover still warms a row", async () => {
  await visit(800);
  await waitFor(() => expect(row("i5")).not.toBeNull());
  (row("i1") as HTMLElement).focus();
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTime(500));
  const start = api.calls.length;
  const targetGets = () =>
    api.calls
      .slice(start)
      .filter(
        (c) => c.method === "GET" && (c.url === "/api/tasks/T-7" || c.url === "/api/agents/dev"),
      );
  for (let n = 0; n < 4; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(100));
  }
  expect(document.activeElement).toBe(row("i5"));
  for (let n = 0; n < 4; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(100));
  }
  expect(document.activeElement).toBe(row("i1"));
  await act(async () => vi.advanceTimersByTime(500));
  expect(targetGets()).toEqual([]);
  fireEvent.mouseEnter(row("i3") as HTMLElement);
  await act(async () => vi.advanceTimersByTime(50));
  expect(targetGets().map((c) => c.url)).toEqual(["/api/tasks/T-7"]);
});
