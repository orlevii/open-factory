import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatInboxTime } from "@/features/session/format";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, type MockApi, mockApi } from "@/test/mock-api";
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

const originalMatchMedia = window.matchMedia;
const BODY =
  "@a and @b exchanged 22 messages in 3 minutes; further messages between them are held.";

type Hold = {
  id: string;
  agents: [{ slug: string; status: string }, { slug: string; status: string }];
  waiting: number;
  sentOn: number;
  resumedAt: string | null;
  resumedBy: string | null;
};
const hold = (o: Partial<Hold> = {}): Hold => ({
  id: "h1",
  agents: [
    { slug: "a", status: "live" },
    { slug: "b", status: "live" },
  ],
  waiting: 4,
  sentOn: 0,
  resumedAt: null,
  resumedBy: null,
  ...o,
});
const holdItem = (o: Partial<Hold> = {}) => ({
  id: "i1",
  messageId: "m-i1",
  kind: "notice",
  read: true,
  from: { kind: "factory", name: "factory" },
  about: "a",
  to: "@alice",
  preview: BODY,
  urgent: false,
  createdAt: new Date(2026, 10, 25, 13, 50).toISOString(),
  notice: "loop_held",
  loopHold: hold(o),
  link: { kind: "session", agentSlug: "a" },
});
const other = {
  id: "i2",
  messageId: "m-i2",
  kind: "notice",
  read: true,
  from: { kind: "agent", name: "dev" },
  to: "@alice",
  preview: "other item",
  urgent: false,
  createdAt: new Date(2026, 10, 25, 13, 40).toISOString(),
  link: { kind: "session", agentSlug: "dev", seq: 4 },
};

let items: unknown[];
let api: MockApi;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 25, 15, 0));
  items = [holdItem(), other];
  api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0, byAgent: {} }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

const pane = () => screen.getByRole("region", { name: "Reading pane" });
async function open(o: Partial<Hold> = {}) {
  items = [holdItem(o), other];
  fakeMatchMedia.installWidth(1280);
  renderApp("/inbox?item=i1", alice);
  await within(await screen.findByRole("region", { name: "Reading pane" })).findByText(
    /exchanged 22 messages/,
  );
}
const resumeButton = (name = "Resume @a and @b") => within(pane()).findByRole("button", { name });
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const posts = () => api.calls.filter((c) => c.method === "POST");

test.each([
  [4, "4 messages waiting"],
  [1, "1 message waiting"],
  [0, "Nothing is waiting"],
])("%i waiting reads %s", async (waiting, line) => {
  await open({ waiting });
  expect(within(pane()).getByText(line)).toBeInTheDocument();
});

test("the pane has the text and two session links, but no composer and no header Open link", async () => {
  await open();
  const p = pane();
  expect(p).toHaveTextContent(BODY);
  expect(within(p).getByRole("link", { name: "Open @a's session" })).toHaveAttribute(
    "href",
    "/agents/a/session",
  );
  expect(within(p).getByRole("link", { name: "Open @b's session" })).toHaveAttribute(
    "href",
    "/agents/b/session",
  );
  expect(within(p).queryByRole("link", { name: /^Open (chat|in session)$/ })).toBeNull();
  expect(within(p).queryByRole("combobox")).toBeNull();
  expect(within(p).queryByRole("textbox")).toBeNull();
});

test("a terminated agent is named, and what is waiting still shows", async () => {
  await open({
    agents: [
      { slug: "a", status: "live" },
      { slug: "b", status: "terminated" },
    ],
    waiting: 1,
  });
  expect(within(pane()).getByText(/was terminated/)).toHaveTextContent(
    "@b was terminated; its held messages were rejected.",
  );
  expect(within(pane()).getByText("1 message waiting")).toBeInTheDocument();
});

test("Resume posts once, shows Resuming… aria-disabled, then the status line takes focus", async () => {
  let release: (r: Response) => void = () => {};
  api.on(
    "POST /api/loop-holds/h1/resume",
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  await open();
  await user().click(await resumeButton());
  const busy = await resumeButton("Resuming…");
  expect(busy).toHaveAttribute("aria-disabled", "true");
  expect(busy).toHaveAttribute("aria-busy", "true");
  await user().click(busy);
  expect(posts()).toHaveLength(1);
  await act(async () => release(json({ sentOn: 4 })));
  const status = await within(pane()).findByRole("status");
  expect(status).toHaveTextContent(
    `Resumed by you · ${formatInboxTime(new Date(), new Date())} · 4 messages sent on`,
  );
  expect(status).toHaveFocus();
  expect(within(pane()).queryByRole("button", { name: /Resum/ })).toBeNull();
});

test("a Resume that had nothing to send says so", async () => {
  api.on("POST /api/loop-holds/h1/resume", () => json({ sentOn: 0 }));
  await open();
  await user().click(await resumeButton());
  expect(await within(pane()).findByRole("status")).toHaveTextContent(
    /Resumed by you · .* · nothing was left to send$/,
  );
});

test("a 409 shows who resumed first, from the error body, with no failure line", async () => {
  api.on("POST /api/loop-holds/h1/resume", () =>
    json(
      {
        error: {
          code: "conflict",
          message: "Already resumed",
          resumedBy: "@ana",
          resumedAt: new Date(2026, 10, 25, 14, 1).toISOString(),
        },
      },
      409,
    ),
  );
  await open();
  await user().click(await resumeButton());
  expect(await within(pane()).findByRole("status")).toHaveTextContent("Resumed by @ana · 14:01");
  expect(screen.queryByText("Couldn't resume. Try again.")).toBeNull();
});

test("another human's earlier Resume shows from the hold: its count, a date when not today, a full-timestamp title", async () => {
  const at = new Date(2026, 10, 24, 9, 5);
  await open({ resumedAt: at.toISOString(), resumedBy: "@ana", sentOn: 3, waiting: 0 });
  const status = within(pane()).getByRole("status");
  expect(status).toHaveTextContent("Resumed by @ana · Yesterday 09:05 · 3 messages sent on");
  expect(within(status).getByText("Yesterday 09:05")).toHaveAttribute("title", at.toLocaleString());
  expect(within(pane()).queryByRole("button", { name: /Resume/ })).toBeNull();
  expect(within(pane()).queryByText(/waiting|Nothing is waiting/)).toBeNull();
});

test("your own earlier Resume, seen after a reload, says you", async () => {
  await open({
    resumedAt: new Date(2026, 10, 25, 14, 30).toISOString(),
    resumedBy: "@alice",
    sentOn: 2,
    waiting: 0,
  });
  expect(within(pane()).getByRole("status")).toHaveTextContent(
    "Resumed by you · 14:30 · 2 messages sent on",
  );
});

test("a 409 with an empty resumedBy reads Resumed · time", async () => {
  api.on("POST /api/loop-holds/h1/resume", () =>
    json(
      {
        error: {
          code: "conflict",
          message: "Already resumed",
          resumedBy: "",
          resumedAt: new Date(2026, 10, 25, 14, 1).toISOString(),
        },
      },
      409,
    ),
  );
  await open();
  await user().click(await resumeButton());
  expect(await within(pane()).findByRole("status")).toHaveTextContent(/^Resumed · 14:01$/);
});

test("a failed Resume keeps the button and says so", async () => {
  api.on("POST /api/loop-holds/h1/resume", () =>
    json({ error: { code: "internal", message: "boom" } }, 500),
  );
  await open();
  await user().click(await resumeButton());
  expect(await within(pane()).findByText("Couldn't resume. Try again.")).toBeInTheDocument();
  expect(await resumeButton()).not.toHaveAttribute("aria-disabled");
});

test("navigating away mid-Resume and back shows the button until inbox_changed brings resumedAt", async () => {
  let release: (r: Response) => void = () => {};
  api.on(
    "POST /api/loop-holds/h1/resume",
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  await open();
  await user().click(await resumeButton());
  await resumeButton("Resuming…");
  await user().click(screen.getByRole("link", { name: /From @dev/ }));
  await within(pane()).findByText("other item");
  await user().click(screen.getByRole("link", { name: /From Factory about @a/ }));
  expect(await resumeButton()).not.toHaveAttribute("aria-disabled");
  items = [
    holdItem({ resumedAt: new Date(2026, 10, 25, 14, 30).toISOString(), resumedBy: "@alice" }),
    other,
  ];
  await act(async () => {
    release(json({ sentOn: 4 }));
    ws.onMessage?.({ type: "inbox_changed" });
  });
  await waitFor(() =>
    expect(within(pane()).getByRole("status")).toHaveTextContent("Resumed by you · 14:30"),
  );
});
