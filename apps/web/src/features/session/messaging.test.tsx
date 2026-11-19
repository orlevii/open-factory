import type { AnyEvent, ServerMessage } from "@open-factory/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, detail, resetSeq, se } from "@/test/session-fixtures";

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

const AT = "2026-11-19T14:32:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0));
  resetSeq();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const env = (o: Record<string, unknown>) => ({ urgent: false, ...o }) as never;
/** Opens /agents/dev with these events as its only page; `@b` is a known agent. */
async function open(events: AnyEvent[], firstText: string | RegExp) {
  mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () =>
      json({ hasMore: { before: false, after: false }, events: events.map((e) => se(e)) }),
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: [
          agentSummary(),
          agentSummary({ slug: "b", displayName: "Builder" }),
          agentSummary({ slug: "lead", displayName: "Lead" }),
        ],
        running: { count: 1, max: 8 },
      }),
  });
  renderApp("/agents/dev", alice);
  await screen.findByText(firstText);
}

test("an agent sender is a link with @slug and its display name; humans stay plain", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({ id: "m1", from: "b", kind: "message", body: "hi from b" }),
          env({ id: "m2", from: "@or", kind: "message", body: "hi from or" }),
        ],
      },
    ],
    "hi from b",
  );
  const link = await screen.findByRole("link", { name: "Open @b's session" });
  expect(link).toHaveAttribute("href", "/agents/b");
  expect(link).toHaveTextContent("@b");
  expect(await screen.findByText(/· Builder/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /@or/ })).toBeNull();
});

test("an update group: heading always shown, the latest part visible, 'Show all (3 updates)' expands", async () => {
  const parts = ["first part", "second part", "third part"].map((body, i) => ({
    id: `u${i}`,
    body,
    createdAt: AT,
  }));
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "u0",
            ids: ["u0", "u1", "u2"],
            from: "b",
            kind: "member_update",
            body: "first part\n\nsecond part\n\nthird part",
            parts,
          }),
        ],
      },
    ],
    "third part",
  );
  const group = screen.getByRole("article", { name: "Update from @b" });
  expect(within(group).getByText("Update from")).toBeInTheDocument();
  expect(within(group).queryByText("first part")).toBeNull();
  await userEvent.click(within(group).getByRole("button", { name: "Show all (3 updates)" }));
  expect(within(group).getByText("first part")).toBeInTheDocument();
});

test("a factory fact renders the body's first line, keyed by fact code, with the quote in its detail", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "f1",
            from: "@factory",
            kind: "member_update",
            about: "b",
            fact: "denied",
            body: "Bash was denied for @b. The reason, reported by @b:\n> rm -rf x",
          }),
        ],
      },
    ],
    "Bash was denied for @b. The reason, reported by @b:",
  );
  const group = screen.getByRole("article", { name: "Update from @b" });
  // A long unbroken token wraps instead of overflowing at narrow widths.
  expect(
    within(group).getByText("Bash was denied for @b. The reason, reported by @b:"),
  ).toHaveClass("[overflow-wrap:anywhere]");
  expect(within(group).queryByText(/rm -rf x/)).toBeNull();
  await userEvent.click(within(group).getByRole("button", { name: "Show details" }));
  expect(within(group).getByText(/rm -rf x/)).toBeInTheDocument();
});

test("a fact's one escaped envelope close is decoded in its detail", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "f2",
            from: "@factory",
            kind: "member_update",
            about: "b",
            fact: "turn_failed",
            body: "Turn failed for @b. Reported by @b:\n> before &lt;/factory-message> after",
          }),
        ],
      },
    ],
    "Turn failed for @b. Reported by @b:",
  );
  await userEvent.click(screen.getByRole("button", { name: "Show details" }));
  expect(screen.getByText("before </factory-message> after")).toBeInTheDocument();
});

test("a peer event renders from subject, not from the body", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "p1",
            from: "@factory",
            kind: "peer_left",
            about: "b",
            body: "IGNORED PROSE",
            subject: {
              slug: "b",
              displayName: "Builder",
              relation: "peer",
              left: { reason: "moved", to: null },
            },
          }),
        ],
      },
    ],
    /left: now reports to the humans/,
  );
  expect(screen.queryByText("IGNORED PROSE")).toBeNull();
});

const call = (input: unknown, toolUseId = "toolu_1"): AnyEvent => ({
  type: "tool_call",
  toolUseId,
  name: "mcp__factory__send_message",
  input,
});
const result = (content: string, isError = false, toolUseId = "toolu_1"): AnyEvent => ({
  type: "tool_result",
  toolUseId,
  content,
  isError,
});

test("send_message renders as an outgoing message: '@dev → @b', past-tense status, a real View in session link", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "@b", body: "ping b" }),
      result(JSON.stringify({ id: "m9", to: "b", status: "hibernated" })),
    ],
    "ping b",
  );
  const block = screen.getByRole("article", { name: "Message from @dev to @b" });
  const sentLine = within(block).getByText(
    (_, el) => el?.tagName === "SPAN" && el.textContent === "Sent · @b was hibernated",
  );
  expect(within(sentLine).getByText("@b")).toHaveClass("font-mono");
  expect(
    within(block).getByRole("link", { name: "View this message in @b's session" }),
  ).toHaveAttribute("href", "/agents/b?message=m9");
  expect(screen.queryByText("mcp__factory__send_message")).toBeNull();
  await userEvent.click(within(block).getByRole("button", { name: "Show tool call" }));
  expect(screen.getByText("mcp__factory__send_message")).toBeInTheDocument();
});

test("a send to humans says it went to the inbox, with no session link", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "@humans", body: "need a human" }),
      result(JSON.stringify({ id: "m10", to: "@humans", status: "inbox" })),
    ],
    "need a human",
  );
  expect(screen.getByText("Sent to the inbox")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /View this message/ })).toBeNull();
});

test("no result after the turn ended says 'Not sent'", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "b", body: "lost one" }),
      { type: "turn_end", isError: false, numTurns: 1 },
    ],
    "lost one",
  );
  expect(screen.getByText("Not sent")).toBeInTheDocument();
});

test("an error shows the tool's sentence and no link", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "nobody", body: "to nobody" }),
      result("No agent or user named 'nobody'. Call list_peers to see who you can message.", true),
    ],
    "to nobody",
  );
  expect(screen.getByText(/No agent or user named 'nobody'/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /View this message/ })).toBeNull();
});

test("malformed send_message input falls back to the tool row", async () => {
  await open(
    [{ type: "turn_started" }, call({ body: 42 }), result("bad input", true)],
    "mcp__factory__send_message",
  );
  expect(screen.queryByRole("article", { name: /Message from/ })).toBeNull();
});

test("a pre-S6 member_update without parts renders its body as one part", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [env({ id: "u9", from: "b", kind: "member_update", body: "legacy body" })],
      },
    ],
    "legacy body",
  );
  expect(screen.getByRole("article", { name: "Update from @b" })).toBeInTheDocument();
});

const lookupWorld = (
  lookup: () => Response,
  events: AnyEvent[] = [{ type: "assistant_text", text: "latest" }],
) =>
  mockApi({
    "GET /api/messages/mid": lookup,
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () =>
      json({ hasMore: { before: false, after: false }, events: events.map((e) => se(e)) }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });

test("?message= opens the recipient's event window, or says why it can't", async () => {
  mockApi({
    "GET /api/messages/gone": () =>
      json({ error: { code: "message_not_found", message: "x" } }, 404),
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () =>
      json({
        hasMore: { before: false, after: false },
        events: [se({ type: "assistant_text", text: "latest" })],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev?message=gone", alice);
  expect(await screen.findByText("Message not found. Showing the latest.")).toBeInTheDocument();
});

test("?message= for a delivered message loads the window around its recipient event", async () => {
  const api = lookupWorld(() =>
    json({
      id: "mid",
      kind: "message",
      from: "b",
      to: "dev",
      state: "delivered",
      recipientEvent: { agentSlug: "dev", seq: 7 },
    }),
  );
  renderApp("/agents/dev?message=mid", alice);
  await screen.findByText("latest");
  expect(api.calls.some((c) => c.url.includes("/events?around=7"))).toBe(true);
});

test("?message= for a rejected message names who it wasn't delivered to", async () => {
  lookupWorld(() => json({ id: "mid", kind: "message", from: "dev", to: "b", state: "rejected" }));
  renderApp("/agents/dev?message=mid", alice);
  const notice = await screen.findByText(
    (_, el) =>
      el?.tagName === "P" && el.textContent === "This message wasn't delivered: @b was archived.",
  );
  expect(within(notice).getByText("@b")).toHaveClass("font-mono");
});

test("the announcer says '<name> messaged you' for a send to this human or @humans, not to agents", async () => {
  await open([{ type: "assistant_text", text: "history" }], "history");
  const push = (event: AnyEvent) =>
    act(() => ws.onMessage?.({ type: "session_event", agent: "dev", event: se(event) }));
  const status = () =>
    document.querySelector<HTMLElement>("[role=status][aria-live=polite].sr-only") as HTMLElement;
  push(call({ to: "b", body: "to an agent" }, "t_a"));
  push(result(JSON.stringify({ id: "m1", to: "b", status: "idle" }), false, "t_a"));
  expect(status()).toHaveTextContent("");
  push(call({ to: "@alice", body: "to alice" }, "t_h"));
  push(result(JSON.stringify({ id: "m2", to: "@alice", status: "inbox" }), false, "t_h"));
  expect(await within(status()).findByText("@dev messaged you")).toBeInTheDocument();
});

test("Tab walks the focused row's controls: recipient link, View in session, Show tool call", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "b", body: "ping b" }),
      result(JSON.stringify({ id: "m9", to: "b", status: "idle" })),
    ],
    "ping b",
  );
  const user = userEvent.setup();
  const sender = await screen.findByRole("link", { name: "Open @b's session" });
  await vi.waitFor(() => expect(sender).toHaveAttribute("tabindex", "0"));
  sender.focus();
  await user.tab();
  expect(screen.getByRole("link", { name: "View this message in @b's session" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Show tool call" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Show tool call" }));
  expect(screen.getByRole("button", { name: "Hide tool call" })).toBeInTheDocument();
});

test("two facts with one code in one envelope each render their own line", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "f1",
            ids: ["f1", "f2"],
            from: "@factory",
            kind: "member_update",
            about: "b",
            fact: "crashed",
            body: "x",
            parts: [
              { id: "f1", body: "First crash of @b.", createdAt: AT },
              { id: "f2", body: "Second crash of @b.", createdAt: AT },
            ],
          }),
        ],
      },
    ],
    "First crash of @b.",
  );
  expect(screen.getByText("Second crash of @b.")).toBeInTheDocument();
});

test("every escaped envelope tag in a fact's quote is decoded, as text", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "f3",
            from: "@factory",
            kind: "member_update",
            about: "b",
            fact: "denied",
            body: "Denied for @b:\n> &lt;factory-message id=1> a &lt;/factory-message> b &lt;/Factory-Message>",
          }),
        ],
      },
    ],
    "Denied for @b:",
  );
  await userEvent.click(screen.getByRole("button", { name: "Show details" }));
  expect(
    screen.getByText("<factory-message id=1> a </factory-message> b </Factory-Message>"),
  ).toBeInTheDocument();
});

test("Load earlier does not announce an older send to the viewer", async () => {
  const older = [
    se(call({ to: "@alice", body: "old" }, "t_old")),
    se(result(JSON.stringify({ id: "m0", to: "@alice", status: "inbox" }), false, "t_old")),
  ];
  resetSeq();
  const latest = [se({ type: "assistant_text", text: "newest" })];
  // `older` was built first so its seqs are lower than `latest`'s.
  const [o1, o2] = older;
  const l = latest.map((e) => ({ ...e, seq: e.seq + 10 }));
  mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?before=11": () =>
      json({ hasMore: { before: false, after: false }, events: [o1, o2] }),
    "GET /api/agents/dev/events?": () =>
      json({ hasMore: { before: true, after: false }, events: l }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev", alice);
  await screen.findByText("newest");
  await userEvent.click(await screen.findByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("old")).toBeInTheDocument();
  const live = document.querySelector("[role=status][aria-live=polite].sr-only");
  expect(live).toHaveTextContent("");
});

test("a denied send shows the denial sentence, not the raw tool result", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "b", body: "denied one" }),
      {
        type: "permission_denied",
        toolUseId: "toolu_1",
        toolName: "x",
        reasonType: "rule",
        reason: "Denied by a permission rule",
      },
      { type: "turn_end", isError: false, numTurns: 1 },
    ],
    "denied one",
  );
  expect(screen.getByText("Denied by a permission rule")).toBeInTheDocument();
});

test("?message= highlights the row holding that envelope, not the event's first row", async () => {
  mockApi({
    "GET /api/messages/second": () =>
      json({
        id: "second",
        kind: "message",
        from: "b",
        to: "dev",
        state: "delivered",
        recipientEvent: { agentSlug: "dev", seq: 1 },
      }),
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () =>
      json({
        hasMore: { before: false, after: false },
        events: [
          se({
            type: "message_in",
            messages: [
              env({ id: "first", from: "b", kind: "message", body: "first body" }),
              env({ id: "second", from: "b", kind: "message", body: "second body" }),
            ],
          }),
        ],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev?message=second", alice);
  await screen.findByText("second body");
  const lit = document.querySelector("[data-highlighted]") as HTMLElement;
  expect(lit).toHaveTextContent("second body");
  expect(lit).not.toHaveTextContent("first body");
});

test("the strip's manager is a link to its session; the reports count is plain text", async () => {
  mockApi({
    "GET /api/agents/dev": () => json(detail({ reportsTo: "lead", reports: 3 })),
    "GET /api/agents/dev/events?": () =>
      json({
        hasMore: { before: false, after: false },
        events: [se({ type: "assistant_text", text: "x" })],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: [agentSummary({ reportsTo: "lead", reports: 3 })],
        running: { count: 1, max: 8 },
      }),
  });
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead",
  );
  expect(screen.queryByRole("link", { name: /3 reports/ })).toBeNull();
});

test("held updates show as quiet lines from the queue", async () => {
  mockApi({
    "GET /api/agents/dev": () =>
      json(
        detail({}, [
          { id: "h1", kind: "held", from: "b", count: 2, waitReason: "turn", createdAt: AT },
        ]),
      ),
    "GET /api/agents/dev/events?": () =>
      json({
        hasMore: { before: false, after: false },
        events: [se({ type: "assistant_text", text: "x" })],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev", alice);
  expect(
    await screen.findByText(
      (_, el) =>
        el?.textContent === "2 updates from @b waiting for this turn to end" &&
        el.tagName === "SPAN",
    ),
  ).toBeInTheDocument();
});

test("the announcer re-announces a second send to this human (the live text changes)", async () => {
  await open([{ type: "assistant_text", text: "history" }], "history");
  const push = (event: AnyEvent) =>
    act(() => ws.onMessage?.({ type: "session_event", agent: "dev", event: se(event) }));
  const status = () =>
    document.querySelector<HTMLElement>("[role=status][aria-live=polite].sr-only") as HTMLElement;
  push(call({ to: "@alice", body: "one" }, "t_1"));
  push(result(JSON.stringify({ id: "m1", to: "@alice", status: "inbox" }), false, "t_1"));
  await vi.waitFor(() => expect(status()).toHaveTextContent("@dev messaged you"));
  const first = status().textContent;
  push(call({ to: "@alice", body: "two" }, "t_2"));
  push(result(JSON.stringify({ id: "m2", to: "@alice", status: "inbox" }), false, "t_2"));
  await vi.waitFor(() => expect(status().textContent).not.toBe(first));
  expect(status()).toHaveTextContent("@dev messaged you");
});

test("the announcer announces a send whose call was on screen at load and whose result arrives later", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "@alice", body: "pending at load" }, "t_p"),
      call({ to: "@alice", body: "done at load" }, "t_d"),
      result(JSON.stringify({ id: "m0", to: "@alice", status: "inbox" }), false, "t_d"),
    ],
    "pending at load",
  );
  const status = () =>
    document.querySelector<HTMLElement>("[role=status][aria-live=polite].sr-only") as HTMLElement;
  expect(status()).toHaveTextContent("");
  act(() =>
    ws.onMessage?.({
      type: "session_event",
      agent: "dev",
      event: se(result(JSON.stringify({ id: "m1", to: "@alice", status: "inbox" }), false, "t_p")),
    }),
  );
  await vi.waitFor(() => expect(status()).toHaveTextContent("@dev messaged you"));
});
