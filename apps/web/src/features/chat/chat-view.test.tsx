import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mergePrincipals } from "@/features/principals/api";
import {
  ALICE_REF,
  chatMsg,
  DEV_REF,
  json,
  mine,
  page,
  principal,
  stubChatApi,
} from "@/test/chat-fixtures";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { onChatChanged } from "./use-chat";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: {
    onStatus?: (s: string) => void;
    onOpen?: () => void;
    onMessage?: (m: ServerMessage) => void;
  }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});

const QA_REF = "0qa00000";
const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}`).join("\n\n");
const row = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);
const openMenu = async (r: HTMLElement | null) => {
  const wrap = r?.closest("[data-row-wrap]") as HTMLElement;
  fireEvent.pointerDown(within(wrap).getByRole("button", { name: "Row actions" }), {
    button: 0,
    pointerType: "mouse",
  });
  return screen.findByRole("menu");
};

test("your message is unboxed under its speaker line 'You' and clamped at 40 lines", async () => {
  stubChatApi({ chat: () => page([mine(1, { body: paragraphs(60) })]) });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const r = (await waitFor(() => {
    const el = row("m1");
    expect(el).not.toBeNull();
    return el;
  })) as HTMLElement;
  expect(r.querySelector("[data-message-block]")).toBeNull();
  expect(within(r).getByText("You")).toBeInTheDocument();
  expect(within(r).getByRole("button", { name: "Show all" })).toBeInTheDocument();
  expect(within(r).queryByText("Paragraph 60")).toBeNull();
  fireEvent.click(within(r).getByRole("button", { name: "Show all" }));
  expect(await within(r).findByText("Paragraph 60")).toBeInTheDocument();
});

test("a human message keeps its urgent badge, attachments and Also-to", async () => {
  stubChatApi({
    principals: [principal(QA_REF, "qa")],
    chat: () =>
      page([
        mine(1, {
          urgent: true,
          recipients: [{ ref: DEV_REF }, { ref: QA_REF }],
          body: "see this\n\n[attached: .factory/uploads/20261123-0a1b2c3d-0000-4000-8000-000000000001-notes.txt]",
          attachments: [
            {
              uploadId: "0a1b2c3d-0000-4000-8000-000000000001",
              name: "notes.txt",
              kind: "text",
              bytes: 12,
            },
          ],
        }),
      ]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const r = (await waitFor(() => {
    const el = row("m1");
    expect(el).not.toBeNull();
    return el;
  })) as HTMLElement;
  expect(within(r).getByText("Urgent")).toBeInTheDocument();
  expect(await within(r).findByRole("group", { name: "Also to @qa" })).toBeInTheDocument();
  const files = within(r).getByRole("list", { name: "Attached files" });
  expect(within(files).getByRole("link", { name: /notes\.txt/ })).toHaveAttribute(
    "href",
    `/api/agents/${refFor("dev")}/uploads/0a1b2c3d-0000-4000-8000-000000000001`,
  );
  expect(within(r).queryByText(/\[attached:/)).toBeNull();
});

const outcome = (key: string, endedAt: string) =>
  ({
    kind: "turn_outcome",
    key,
    turnId: `t-${key}`,
    endedAt,
    eventSeq: null,
    outcome: "no_reply",
  }) as const;
const speakerLines = () => document.querySelectorAll("[data-speaker-line]").length;

test.each([
  ["the same sender within five minutes shares one speaker line", [mine(1), mine(2)], 1],
  [
    "a gap over five minutes starts a new speaker line",
    [mine(1), mine(2, { createdAt: "2026-11-23T09:06:00.000Z" })],
    2,
  ],
  ["a different sender starts a new speaker line", [mine(1), chatMsg(2)], 2],
  [
    "an item between the messages starts a new speaker line",
    [mine(1), outcome("m1", "2026-11-23T09:00:01.500Z"), mine(2)],
    2,
  ],
  ["an urgent message keeps its own speaker line", [mine(1), mine(2, { urgent: true })], 2],
] as const)("grouping: %s", async (_name, entries, lines) => {
  stubChatApi({ chat: () => page([...entries]) });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Ask 1");
  expect(speakerLines()).toBe(lines);
  // Every message still has its time on screen (a grouped one shows it on hover or focus).
  expect(document.querySelectorAll("[data-row] time")).toHaveLength(
    entries.filter((e) => e.kind === "message").length,
  );
});

test("after principal_updated, a chat speaker line shows the new handle", async () => {
  stubChatApi({ chat: () => page([chatMsg(1)]) });
  const { queryClient } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Reply 1");
  const line = () => row("m1")?.querySelector("[data-speaker-line]") as HTMLElement;
  await waitFor(() => expect(queryClient.getQueryData(["principals"])).toBeDefined());
  expect(within(line()).getByText("@dev")).toBeInTheDocument();
  // The frame's handler merges the renamed principal like this.
  act(() => mergePrincipals(queryClient, [principal(DEV_REF, "builder")]));
  expect(await within(line()).findByText("@builder")).toBeInTheDocument();
  expect(within(line()).queryByText("@dev")).toBeNull();
});

test("a principal_updated frame relabels a tag chip in a message body with no principals fetch", async () => {
  stubChatApi({
    principals: [principal(QA_REF, "qa")],
    chat: () => page([chatMsg(1, { body: `ask <@${QA_REF}> about it` })]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText(/about it/);
  const chip = () => document.querySelector<HTMLElement>(`[data-of-tag="${QA_REF}"]`);
  await waitFor(() => expect(chip()).toHaveTextContent("@qa"));
  const principalFetches = () =>
    vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).startsWith("/api/principals")).length;
  const before = principalFetches();
  await waitFor(() => expect(ws.onMessage).toBeDefined());
  act(() => ws.onMessage?.({ type: "principal_updated", principal: principal(QA_REF, "quality") }));
  await waitFor(() => expect(chip()).toHaveTextContent("@quality"));
  expect(principalFetches()).toBe(before);
});

test("the agent's reply is unboxed prose and never clamped", async () => {
  stubChatApi({ chat: () => page([chatMsg(1, { body: paragraphs(60) })]) });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByText("Paragraph 60")).toBeInTheDocument();
  const r = row("m1") as HTMLElement;
  expect(r.querySelector("[data-message-block]")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

test("'also to' counts the rest, and the full list is the accessible name and the menu's Recipients", async () => {
  const handles = ["qa", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"];
  const others = handles.map((h) => `@${h}`);
  const refs = handles.map((_, i) => `0ther00${i}`);
  stubChatApi({
    principals: handles.map((h, i) => principal(refs[i] as string, h)),
    chat: () =>
      page([chatMsg(1, { recipients: [{ ref: ALICE_REF }, ...refs.map((ref) => ({ ref }))] })]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const group = await screen.findByRole("group", { name: `Also to ${others.join(", ")}` });
  expect(group).toHaveTextContent("also to");
  expect(group).toHaveTextContent("and 8 others");
  const menu = await openMenu(row("m1"));
  expect(within(menu).getByText("Recipients")).toBeInTheDocument();
  expect(menu).toHaveTextContent(["@alice", ...others].join(", "));
});

test("one other recipient reads 'also to @qa', with no count", async () => {
  stubChatApi({
    principals: [principal(QA_REF, "qa")],
    chat: () => page([mine(1, { recipients: [{ ref: DEV_REF }, { ref: QA_REF }] })]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const group = await screen.findByRole("group", { name: "Also to @qa" });
  expect(group).toHaveTextContent("also to");
  expect(group).not.toHaveTextContent("others");
});

test("a recipient the cache can't name yet reads '@…', and '@unknown' only once the server says nobody has it", async () => {
  const GHOST = "0gh00000";
  stubChatApi({
    principals: [principal(QA_REF, "qa")],
    chat: () =>
      page([mine(1, { recipients: [{ ref: DEV_REF }, { ref: GHOST }, { ref: QA_REF }] })]),
  });
  const base = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  let answer: (r: Response) => void = () => {};
  let asked = false;
  vi.stubGlobal("fetch", (u: string, i?: RequestInit) =>
    u.includes(`/api/principals?refs=`)
      ? new Promise<Response>((r) => {
          asked = true;
          answer = r;
        })
      : base(u, i),
  );
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  // Once the list has loaded (it names @qa), the ghost is still only pending.
  await screen.findByRole("group", { name: "Also to @…, @qa" });
  expect(document.body).not.toHaveTextContent("@unknown");
  await waitFor(() => expect(asked).toBe(true));
  await act(async () => answer(json({ principals: [] })));
  await screen.findByRole("group", { name: "Also to @unknown, @qa" });
});

test("the row menu: Copy text, Copy link to ?message=, View in session; no Recipients without others", async () => {
  stubChatApi({ chat: () => page([chatMsg(1)]) });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Reply 1");
  const menu = await openMenu(row("m1"));
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
  expect(items).toEqual(["Copy text", "Copy link", "View in session"]);
  expect(screen.queryByText("Recipients")).toBeNull();
  const session = within(menu).getByText("View in session").closest("a");
  expect(session).toHaveAttribute("href", `/agents/${refFor("dev")}/session?message=m1`);
  fireEvent.click(within(menu).getByText("Copy link"));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${location.origin}/agents/${refFor("dev")}/chat?message=m1`,
    ),
  );
});

test("a pending message waits for the agent's step and cancels in place, with Undo", async () => {
  const calls: string[] = [];
  stubChatApi({
    chat: () => page([mine(1, { state: "pending" })]),
    other: (url, init) => {
      if (!url.includes("/queue/")) return undefined;
      calls.push(`${init?.method} ${url}`);
      return init?.method === "DELETE"
        ? json({
            item: {
              id: "m1",
              kind: "message",
              from: "@alice",
              fromKind: "human",
              createdAt: "2026-11-23T09:00:00.000Z",
            },
          })
        : json({});
    },
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const status = await screen.findByText("Waiting for Dev agent's current step");
  const r = row("m1") as HTMLElement;
  // The status replaces the time in the speaker line and describes the message.
  expect(r.querySelector("[data-speaker-line] time")).toHaveAttribute("aria-hidden", "true");
  expect(r).toHaveAccessibleDescription("Waiting for Dev agent's current step");
  expect(status.closest("[data-speaker-line]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Message cancelled.")).toBeInTheDocument();
  expect(screen.queryByText("Ask 1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Ask 1")).toBeInTheDocument();
  expect(calls).toEqual([
    `DELETE /api/agents/${refFor("dev")}/queue/m1`,
    `POST /api/agents/${refFor("dev")}/queue/m1/restore`,
  ]);
});

test("a rejected message shows 'Not delivered: <reason>' and no Retry", async () => {
  stubChatApi({
    chat: () => page([mine(1, { state: "rejected", rejectReason: "the agent was terminated" })]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByText("Not delivered: the agent was terminated")).toBeInTheDocument();
  expect(row("m1")).toHaveAccessibleDescription("Not delivered: the agent was terminated");
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
});

test("a held message's status becomes its time once delivered, announced politely", async () => {
  let state: "pending" | "delivered" = "pending";
  stubChatApi({ chat: () => page([mine(1, { state })]) });
  const { queryClient } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Waiting for Dev agent's current step");
  state = "delivered";
  act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
  await waitFor(() =>
    expect(screen.queryByText("Waiting for Dev agent's current step")).toBeNull(),
  );
  const r = row("m1") as HTMLElement;
  expect(r.querySelector("[data-speaker-line] time")).not.toHaveAttribute("aria-hidden");
  expect(r).not.toHaveAccessibleDescription("Waiting for Dev agent's current step");
  const region = document
    .querySelector("[data-chat-view]")
    ?.parentElement?.querySelector("[role=status]");
  expect(region).toHaveTextContent("Delivered to Dev agent.");
});

test("the empty thread says so", async () => {
  stubChatApi({ chat: () => page([]) });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByText("No messages with Dev agent yet.")).toBeInTheDocument();
});

test("a failed load says so; Retry shows the skeleton, then the thread", async () => {
  let fail = true;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const requests = stubChatApi({
    chat: async () => {
      if (fail) return json({ error: { code: "internal" } }, 500);
      await gate;
      return page([chatMsg(1)]);
    },
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByText("Couldn't load this chat.")).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull());
  expect(screen.queryByText("Couldn't load this chat.")).toBeNull();
  release();
  expect(await screen.findByText("Reply 1")).toBeInTheDocument();
  expect(requests).toHaveLength(2);
});

test("?message= lands on the message with the arrival tint, and Jump to latest leaves the window", async () => {
  const requests = stubChatApi({
    chat: (url) =>
      url.includes("around=m2")
        ? page([chatMsg(1), chatMsg(2), chatMsg(3)], { newerCursor: "n" })
        : page([chatMsg(1), chatMsg(2), chatMsg(3), chatMsg(4)]),
  });
  const { router } = renderApp(`/agents/${refFor("dev")}/chat?message=m2`, alice);
  await screen.findByText("Reply 2");
  await waitFor(() => expect(row("m2")).toHaveAttribute("data-arrived"));
  expect(row("m1")).not.toHaveAttribute("data-arrived");
  const jump = screen.getByRole("button", { name: /Jump to latest/ });
  expect(jump.closest("[inert]")).toBeNull();
  fireEvent.click(jump);
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(await screen.findByText("Reply 4")).toBeInTheDocument();
  expect(requests).toContain(`/api/agents/${refFor("dev")}/chat?around=m2`);
});

test("a terminated agent's composer place is a read-only line", async () => {
  stubChatApi({ chat: () => page([chatMsg(1)]), agent: { status: "terminated" } });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(
    await screen.findByText("This agent was terminated. The chat is read-only."),
  ).toBeInTheDocument();
});

test("an archived agent's composer place is the archived notice", async () => {
  stubChatApi({
    chat: () => page([chatMsg(1)]),
    agent: { archivedAt: "2026-11-22T10:00:00.000Z" },
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await screen.findByText(/^This agent is archived\./)).toBeInTheDocument();
});

test("a working line is the last row; the outcome takes its place in the same node", async () => {
  let working = true;
  stubChatApi({
    chat: () =>
      working
        ? page([mine(1)], { working: { key: "m1", since: new Date().toISOString() } })
        : page([
            mine(1),
            {
              kind: "turn_outcome",
              key: "m1",
              turnId: "t1",
              endedAt: "2026-11-23T09:05:00.000Z",
              eventSeq: 7,
              outcome: "no_reply",
            },
          ]),
  });
  const { queryClient } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Ask 1");
  const line = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-status-line]");
    expect(el).toHaveAttribute("data-status-line", "working");
    return el as HTMLElement;
  });
  expect(line).toHaveTextContent(/^\d+s · .*is working · Open session$/);
  expect(line).not.toHaveAttribute("data-live");
  expect(line.nextElementSibling).toBeNull();
  working = false;
  act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
  await waitFor(() =>
    expect(document.querySelector("[data-status-line]")).toHaveAttribute(
      "data-status-line",
      "no_reply",
    ),
  );
  // The same element, no fade.
  expect(document.querySelector("[data-status-line]")).toBe(line);
  expect(line).not.toHaveAttribute("data-live");
  expect(line).toHaveTextContent(/finished without replying · Open session$/);
  expect(within(line).getByRole("link")).toHaveAttribute(
    "href",
    `/agents/${refFor("dev")}/session?event=7`,
  );
  expect(
    within(line).getByRole("link", { name: /^Open session at \d\d:\d\d$/ }),
  ).toBeInTheDocument();
});

test.each([
  ["stopped", "Dev agent was stopped before replying · Open session"],
  ["error", "Dev agent hit an error before replying · Open session"],
] as const)("the %s outcome line", async (outcome, text) => {
  stubChatApi({
    chat: () =>
      page([
        mine(1),
        {
          kind: "turn_outcome",
          key: "m1",
          turnId: "t1",
          endedAt: "2026-11-23T09:05:00.000Z",
          eventSeq: null,
          outcome,
        },
      ]),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const line = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-status-line]");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(line).toHaveTextContent(text);
  expect(within(line).getByRole("link")).toHaveAttribute(
    "href",
    `/agents/${refFor("dev")}/session`,
  );
});

test("a live message fades in; what was loaded does not", async () => {
  let thread = [chatMsg(1), chatMsg(2)];
  const { queryClient } =
    (stubChatApi({ chat: () => page(thread) }), renderApp(`/agents/${refFor("dev")}/chat`, alice));
  await screen.findByText("Reply 2");
  expect(document.querySelector("[data-live]")).toBeNull();
  thread = [...thread, chatMsg(3)];
  act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
  await screen.findByText("Reply 3");
  expect(row("m3")?.closest("[data-row-wrap]")).toHaveAttribute("data-live");
  expect(row("m2")?.closest("[data-row-wrap]")).not.toHaveAttribute("data-live");
});

test("a live reply and an outcome are announced politely; a load announces nothing", async () => {
  let thread = [chatMsg(1)];
  const { queryClient } =
    (stubChatApi({ chat: () => page(thread) }), renderApp(`/agents/${refFor("dev")}/chat`, alice));
  await screen.findByText("Reply 1");
  const status = () => document.querySelector<HTMLElement>('[data-chat-view] ~ [role="status"]');
  expect(status()).toHaveAttribute("aria-live", "polite");
  expect(status()).toHaveTextContent("");
  thread = [...thread, chatMsg(2)];
  act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
  await waitFor(() => expect(status()).toHaveTextContent("Dev agent: Reply 2"));
});

test("Load earlier adds older messages above the loaded ones", async () => {
  stubChatApi({
    chat: (url) =>
      url.includes("before=c")
        ? page([chatMsg(1), chatMsg(2)])
        : page([chatMsg(3), chatMsg(4)], { nextCursor: "c" }),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  fireEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  await screen.findByText("Reply 1");
  const order = [...document.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"));
  expect(order).toEqual(["m1", "m2", "m3", "m4"]);
  expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
});

/** jsdom has no layout: a scroll position per element, and a 1000px tall content in a 100px box. */
function stubScrolling() {
  const store = new WeakMap<object, number>();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ["scrollTop", "scrollHeight", "clientHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return store.get(this) ?? 0;
    },
    set(v: number) {
      store.set(this, v);
    },
  });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else Reflect.deleteProperty(proto, k);
    }
  };
}

test("stick to the bottom; a reader who looked up gets Jump to latest with the count", async () => {
  const restore = stubScrolling();
  try {
    let thread = [chatMsg(1), chatMsg(2)];
    const { queryClient } =
      (stubChatApi({ chat: () => page(thread) }),
      renderApp(`/agents/${refFor("dev")}/chat`, alice));
    await screen.findByText("Reply 2");
    const scroller = document.querySelector<HTMLElement>("[data-chat-view]") as HTMLElement;
    // Pinned: a new message keeps the view at the bottom, no pill.
    thread = [...thread, chatMsg(3)];
    act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
    await screen.findByText("Reply 3");
    expect(scroller.scrollTop).toBe(1000);
    expect(
      screen.getByRole("button", { name: /Jump to latest/, hidden: true }),
    ).not.toHaveAttribute("data-shown");
    // The reader looks up: the next message waits behind the pill.
    fireEvent.wheel(scroller, { deltaY: -50 });
    thread = [...thread, chatMsg(4)];
    act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
    await screen.findByText("Reply 4");
    const pill = await screen.findByRole("button", { name: "1 new message" });
    expect(pill).toHaveAttribute("data-shown");
    scroller.scrollTop = 200;
    fireEvent.click(pill);
    expect(scroller.scrollTop).toBe(1000);
  } finally {
    restore();
  }
});
