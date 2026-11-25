import type { ServerMessage } from "@open-factory/shared";
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ onMessage: undefined as ((m: unknown) => void) | undefined }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void; onMessage?: (m: unknown) => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
  ws.onMessage = undefined;
});

const item = {
  id: "i1",
  messageId: "m1",
  kind: "notice",
  read: false,
  from: { kind: "agent", name: "dev" },
  to: "@alice",
  preview: "preview one",
  urgent: false,
  createdAt: new Date(2026, 10, 19, 14, 0).toISOString(),
  link: { kind: "session", agentSlug: "dev", seq: 41 },
};
const none = { hasCredential: false, hasTemplate: false, hasAgent: false };
const row = () => document.querySelector<HTMLElement>('a[data-inbox-id="i1"]');
const block = () => screen.queryByRole("region", { name: "Set up your factory" });
const EMPTY = "Nothing in your inbox.";

let setup: typeof none & { hasAgent: boolean };
let withItem: boolean;
let setupCalls: () => number;
let release: (() => void) | undefined;

function boot(opts: { items?: boolean; hold?: boolean } = {}) {
  setup = { ...none };
  withItem = opts.items ?? false;
  const gate = opts.hold ? new Promise<void>((r) => (release = r)) : undefined;
  const api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items: withItem ? [item] : [], nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0, byAgent: {} }),
    "GET /api/inbox/i1": () => json(item),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "POST /api/inbox/i1/read": () => json({ ok: true }),
    "GET /api/setup": async () => {
      await gate;
      return json(setup);
    },
  });
  setupCalls = () => api.calls.filter((c) => c.url === "/api/setup").length;
}
const visit = async (width: number) => {
  fakeMatchMedia.installWidth(width);
  const app = renderApp("/inbox", alice);
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
  return app;
};
const agentAppears = async (via: "frame" | "focus") => {
  const before = setupCalls();
  setup = { hasCredential: true, hasTemplate: true, hasAgent: true };
  if (via === "frame")
    act(() =>
      ws.onMessage?.({ type: "org_action", action: "agent_created", by: "@hr", subject: "dev" }),
    );
  else {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 31_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  }
  await waitFor(() => expect(setupCalls()).toBeGreaterThan(before));
  // The answer is in the cache once the request has settled.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

beforeEach(() => boot());

test("wide, no agent, nothing selected: the steps are the pane; the list keeps its empty line", async () => {
  await visit(1280);
  const pane = await screen.findByRole("region", { name: "Reading pane" });
  expect(await within(pane).findByRole("region", { name: "Set up your factory" })).toBeVisible();
  expect(within(pane).queryByText("No item selected.")).toBeNull();
  expect(screen.getByText(EMPTY)).toBeVisible();
});

test("wide: selecting an item shows it, clearing the selection brings the steps back", async () => {
  boot({ items: true });
  const app = await visit(1280);
  await waitFor(() => expect(row()).not.toBeNull());
  await screen.findByRole("region", { name: "Set up your factory" });
  fireEvent.click(row() as HTMLElement);
  await waitFor(() => expect(block()).toBeNull());
  expect(
    within(screen.getByRole("region", { name: "Reading pane" })).getByRole("link", {
      name: "Open in session",
    }),
  ).toBeVisible();
  await act(() => app.router.navigate({ to: "/inbox", search: {} }));
  expect(await screen.findByRole("region", { name: "Set up your factory" })).toBeVisible();
});

test("narrow, no items: the steps are on the list and there is no empty line", async () => {
  await visit(390);
  expect(await screen.findByRole("region", { name: "Set up your factory" })).toBeVisible();
  expect(screen.queryByText(EMPTY)).toBeNull();
});

test("narrow, with an item: the steps come first, the item below", async () => {
  boot({ items: true });
  await visit(390);
  const steps = await screen.findByRole("region", { name: "Set up your factory" });
  await waitFor(() => expect(row()).not.toBeNull());
  expect(steps.compareDocumentPosition(row() as HTMLElement)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("an agent already exists: no steps, the usual pane and empty line", async () => {
  boot();
  setup.hasAgent = true;
  await visit(1280);
  expect(await screen.findByText("No item selected.")).toBeVisible();
  expect(await screen.findByText(EMPTY)).toBeVisible();
  expect(block()).toBeNull();
});

test("first paint: the route waits for the setup answer, so the empty line never shows without the steps", async () => {
  boot({ hold: true });
  fakeMatchMedia.installWidth(1280);
  const alone: string[] = [];
  const watch = new MutationObserver(() => {
    if (document.body.textContent?.includes(EMPTY) && !block()) alone.push(EMPTY);
  });
  watch.observe(document.body, { subtree: true, childList: true, characterData: true });
  renderApp("/inbox", alice);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(block()).toBeNull();
  await act(async () => release?.());
  expect(await screen.findByRole("region", { name: "Set up your factory" })).toBeVisible();
  expect(await screen.findByText(EMPTY)).toBeVisible();
  watch.disconnect();
  expect(alone).toEqual([]);
});

test.each(["frame", "focus"] as const)(
  "when an agent appears (%s), the steps leave at once if the pointer is outside the list",
  async (via) => {
    await visit(1280);
    await screen.findByRole("region", { name: "Set up your factory" });
    await agentAppears(via);
    await waitFor(() => expect(block()).toBeNull());
    expect(screen.getByText("No item selected.")).toBeVisible();
  },
);

test("with the pointer over the list column the steps stay until it leaves", async () => {
  boot({ items: true });
  await visit(1280);
  await screen.findByRole("region", { name: "Set up your factory" });
  await waitFor(() => expect(row()).not.toBeNull());
  const user = userEvent.setup();
  await user.hover(row() as HTMLElement);
  await agentAppears("frame");
  expect(block()).not.toBeNull();
  await user.unhover(row() as HTMLElement);
  await waitFor(() => expect(block()).toBeNull());
});

test("with focus inside the list column the steps stay until it leaves", async () => {
  boot({ items: true });
  await visit(1280);
  await screen.findByRole("region", { name: "Set up your factory" });
  await waitFor(() => expect(row()).not.toBeNull());
  act(() => row()?.focus());
  await agentAppears("frame");
  expect(block()).not.toBeNull();
  act(() => row()?.blur());
  await waitFor(() => expect(block()).toBeNull());
});

test("focus on a step does not hold the steps; it lands on the first Inbox row, never on the page", async () => {
  boot({ items: true });
  await visit(1280);
  const steps = await screen.findByRole("region", { name: "Set up your factory" });
  await waitFor(() => expect(row()).not.toBeNull());
  act(() =>
    within(steps)
      .getByRole("button", { name: /Step 1 of 3/ })
      .focus(),
  );
  // Where focus is the moment the steps are gone from the page.
  let atRemoval: Element | null | undefined;
  const watch = new MutationObserver(() => {
    if (atRemoval === undefined && !block()) atRemoval = document.activeElement;
  });
  watch.observe(document.body, { subtree: true, childList: true });
  await agentAppears("frame");
  await waitFor(() => expect(block()).toBeNull());
  watch.disconnect();
  expect(document.activeElement).toBe(row());
  expect(atRemoval).toBe(row());
});

test("with an empty Inbox focus lands on the page heading", async () => {
  await visit(1280);
  const steps = await screen.findByRole("region", { name: "Set up your factory" });
  act(() =>
    within(steps)
      .getByRole("button", { name: /Step 2 of 3/ })
      .focus(),
  );
  await agentAppears("frame");
  await waitFor(() => expect(block()).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Inbox" }));
});
