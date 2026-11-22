import type { AnyEvent, ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
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
async function open(
  events: AnyEvent[],
  firstText: string | RegExp,
  extra: Record<string, () => Response> = {},
) {
  const api = mockApi({
    ...extra,
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
  last.qc = renderApp("/agents/dev", alice).queryClient;
  await screen.findByText(firstText);
  return api;
}
const last = { qc: undefined as undefined | import("@tanstack/react-query").QueryClient };

test("an agent sender is a chip linking to its session (name and @slug); humans stay plain", async () => {
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
  const link = await screen.findByRole("link", { name: /Builder/ });
  expect(link).toHaveAttribute("href", "/agents/b");
  expect(link).toHaveTextContent("@b");
  expect(screen.queryByRole("link", { name: /@or/ })).toBeNull();
});

test("AgentLink resolves an ended agent: terminated keeps its link and name, archived stays plain", async () => {
  const msg = (id: string, from: string, body: string) => env({ id, from, kind: "message", body });
  await open(
    [
      {
        type: "message_in",
        messages: [
          msg("m1", "tech-lead-ab12", "from the terminated one"),
          msg("m2", "old", "from the archived one"),
        ],
      },
    ],
    "from the terminated one",
    {
      "GET /api/agents?ended=only": () =>
        json({
          agents: [
            agentSummary({
              slug: "tech-lead-ab12",
              displayName: "Tech Lead · ab12",
              kind: "ephemeral",
              status: "terminated",
              terminatedAt: AT,
              terminatedBy: "lead",
            }),
            agentSummary({ slug: "old", displayName: "Old one", archivedAt: AT }),
          ],
          more: false,
          running: { count: 1, max: 8 },
        }),
    },
  );
  const link = await screen.findByRole("link", { name: /Tech Lead · ab12/ });
  expect(link).toHaveAttribute("href", "/agents/tech-lead-ab12");
  await vi.waitFor(() => expect(screen.queryByRole("link", { name: /@old/ })).toBeNull());
  expect(screen.getAllByText("@old").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Old one/)).toBeNull();
});

test("AgentLink: a slug in neither list is a link without a name when older ended agents exist, else plain", async () => {
  const events: AnyEvent[] = [
    {
      type: "message_in",
      messages: [env({ id: "m1", from: "gone-ab12", kind: "message", body: "from long ago" })],
    },
  ];
  const endedList = (more: boolean) => () =>
    json({ agents: [], more, running: { count: 1, max: 8 } });
  const api = await open(events, "from long ago", {
    "GET /api/agents?ended=only": endedList(true),
  });
  await vi.waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/agents?ended=only")).toBe(true),
  );
  const link = await screen.findByRole("link", { name: "@gone-ab12" });
  expect(link).toHaveAttribute("href", "/agents/gone-ab12");
  // No name is known: the slug stands in once, never repeated as the handle.
  expect(link.textContent).toBe("@gone-ab12");
});

test("AgentLink: links mounted over time share one ended-list fetch within its stale time", async () => {
  const msg = (id: string, body: string) =>
    ({
      type: "message_in",
      messages: [env({ id, from: "gone-ab12", kind: "message", body })],
    }) as AnyEvent;
  const api = await open([msg("m1", "first from gone")], "first from gone", {
    "GET /api/agents?ended=only": () =>
      json({ agents: [], more: true, running: { count: 1, max: 8 } }),
  });
  const endedFetches = () => api.calls.filter((c) => c.url === "/api/agents?ended=only").length;
  await vi.waitFor(() => expect(endedFetches()).toBe(1));
  // New AgentLinks mount as messages arrive, and the window regains focus: no refetch.
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0, 20));
  for (let i = 2; i <= 4; i++)
    act(() =>
      ws.onMessage?.({
        type: "session_event",
        agent: "dev",
        event: se(msg(`m${i}`, `more from gone ${i}`)),
      }),
    );
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("more from gone 4");
  expect(screen.getAllByRole("link", { name: "@gone-ab12" })).toHaveLength(4);
  expect(endedFetches()).toBe(1);
});

test("AgentLink: an unknown slug is plain once both lists have loaded and nothing older exists", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [env({ id: "m1", from: "nobody", kind: "message", body: "from nobody" })],
      },
    ],
    "from nobody",
    {
      "GET /api/agents?ended=only": () =>
        json({ agents: [], more: false, running: { count: 1, max: 8 } }),
    },
  );
  await vi.waitFor(() => expect(screen.queryByRole("link", { name: /@nobody/ })).toBeNull());
  expect(screen.getByText("@nobody")).toBeInTheDocument();
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

/** Opens the row menu beside `block` (U3 §7.5). */
async function rowMenu(block: HTMLElement) {
  const wrap = block.closest("[data-row-wrap]") as HTMLElement;
  fireEvent.pointerDown(within(wrap).getByRole("button", { name: "Row actions" }), { button: 0 });
  return screen.findByRole("menu");
}

test("send_message renders as an outgoing message: '@dev → @b', past-tense status, no footer links; the call is in the row menu", async () => {
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
  // Outgoing cards have no footer links (U3 §7.5).
  expect(within(block).queryByRole("link", { name: /View this message/ })).toBeNull();
  expect(within(block).queryByRole("button", { name: "Show tool call" })).toBeNull();
  expect(screen.queryByText("mcp__factory__send_message")).toBeNull();
  const menu = await rowMenu(block);
  expect(within(menu).queryByRole("menuitem", { name: "Open in inbox" })).toBeNull();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "View tool call" }));
  expect(screen.getByText("mcp__factory__send_message")).toBeInTheDocument();
  const again = await rowMenu(block);
  expect(within(again).getByRole("menuitem", { name: "Hide tool call" })).toBeInTheDocument();
});

test("a send to humans has no footer; Open in inbox is in the row menu", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "@humans", body: "need a human" }),
      result(JSON.stringify({ id: "m10", to: "@humans", status: "inbox" })),
    ],
    "need a human",
  );
  expect(screen.queryByText("Sent to the inbox")).toBeNull();
  expect(screen.queryByRole("link", { name: /View this message/ })).toBeNull();
  const block = screen.getByRole("article", { name: /Message from @dev/ });
  const menu = await rowMenu(block);
  expect(within(menu).getByRole("menuitem", { name: "Open in inbox" })).toHaveAttribute(
    "href",
    "/inbox",
  );
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
  const api = lookupWorld(() =>
    json({ id: "mid", kind: "message", from: "dev", to: "b", state: "rejected" }),
  );
  api.on("GET /api/agents?ended=only", () =>
    json({
      agents: [agentSummary({ slug: "b", displayName: "Builder", archivedAt: AT })],
      more: false,
      running: { count: 1, max: 8 },
    }),
  );
  renderApp("/agents/dev?message=mid", alice);
  const notice = await screen.findByText(
    (_, el) =>
      el?.tagName === "P" && el.textContent === "This message wasn't delivered: @b was archived.",
  );
  expect(within(notice).getByText("@b")).toHaveClass("font-mono");
});

test("?message= for a message you cancelled says so (U3 §6.4)", async () => {
  lookupWorld(() =>
    json({ id: "mid", kind: "message", from: "@alice", to: "dev", state: "cancelled" }),
  );
  renderApp("/agents/dev?message=mid", alice);
  expect(await screen.findByText("You cancelled this message.")).toBeInTheDocument();
  expect(screen.getByText("latest")).toBeInTheDocument();
});

test("?message= for a message rejected by a terminated recipient says it was terminated", async () => {
  const api = lookupWorld(() =>
    json({ id: "mid", kind: "message", from: "dev", to: "b", state: "rejected" }),
  );
  api.on("GET /api/agents?ended=only", () =>
    json({
      agents: [
        agentSummary({
          slug: "b",
          displayName: "Builder",
          kind: "ephemeral",
          status: "terminated",
          terminatedAt: AT,
          terminatedBy: "dev",
        }),
      ],
      more: false,
      running: { count: 1, max: 8 },
    }),
  );
  renderApp("/agents/dev?message=mid", alice);
  const notice = await screen.findByText(
    (_, el) =>
      el?.tagName === "P" && el.textContent === "This message wasn't delivered: @b was terminated.",
  );
  expect(within(notice).getByText("@b")).toHaveClass("font-mono");
});

test.each([
  [
    "not among the newest ended agents",
    () => json({ agents: [], more: true, running: { count: 1, max: 8 } }),
  ],
  ["the ended list failed", () => json({ error: { code: "internal", message: "x" } }, 500)],
])(
  "?message= for a rejected message is neutral when the recipient's state is unknown (%s)",
  async (_, ended) => {
    const api = lookupWorld(() =>
      json({ id: "mid", kind: "message", from: "dev", to: "b", state: "rejected" }),
    );
    api.on("GET /api/agents?ended=only", ended);
    renderApp("/agents/dev?message=mid", alice);
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent === "This message wasn't delivered: @b is no longer available.",
      ),
    ).toBeInTheDocument();
  },
);

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

test("Tab walks the focused row's controls: the recipient link, then the row menu", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "b", body: "ping b" }),
      result(JSON.stringify({ id: "m9", to: "b", status: "idle" })),
    ],
    "ping b",
  );
  const user = userEvent.setup();
  const sender = await screen.findByRole("link", { name: /Builder/ });
  await vi.waitFor(() => expect(sender).toHaveAttribute("tabindex", "0"));
  sender.focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Row actions" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
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

test("Agent details' manager is a link to its session", async () => {
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
  await userEvent.click(await screen.findByRole("button", { name: "Agent details" }));
  await vi.waitFor(() =>
    expect(document.querySelector('#agent-details a[href="/agents/lead"]')).not.toBeNull(),
  );
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

// ---- S8: task messages in the timeline and the queue ----
test("a task_assigned envelope is a Factory message block with a badge linking to the task", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "t1",
            from: "@factory",
            kind: "task_assigned",
            taskKey: "T-1",
            taskTitle: "Plan the migration",
            body: "@or assigned you T-1\nThe task, written by @or:\n> Read this",
          }),
        ],
      },
    ],
    /assigned you T-1/,
  );
  const block = document.querySelector("[data-message-block]") as HTMLElement;
  expect(within(block).getByText("Factory")).toBeInTheDocument();
  const badge = within(block).getByRole("link", { name: "Task T-1: Plan the migration" });
  expect(badge).toHaveAttribute("href", "/tasks/T-1");
  // The brief is two clamped lines until Show all (U3 §7.2).
  await userEvent.click(within(block).getByRole("button", { name: "Show all" }));
  expect(within(block).getByRole("blockquote")).toHaveTextContent("Read this");
});

test("a task_comment from a human shows the handle and a badge that opens that comment", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "t2",
            from: "@or",
            kind: "task_comment",
            taskKey: "T-1",
            taskTitle: "Plan",
            commentId: "c1",
            body: "yes, go ahead",
          }),
        ],
      },
    ],
    "yes, go ahead",
  );
  const block = document.querySelector("[data-message-block]") as HTMLElement;
  expect(within(block).getByText("@or")).toHaveClass("font-mono");
  expect(within(block).getByRole("link", { name: "Task T-1: Plan" })).toHaveAttribute(
    "href",
    "/tasks/T-1?comment=c1",
  );
});

test("a task_update renders as a message block from the factory, by kind, not by prose", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "t3",
            from: "@factory",
            kind: "task_update",
            fact: "unblocked",
            taskKey: "T-2",
            taskTitle: "Second",
            body: "anything at all",
          }),
        ],
      },
    ],
    "anything at all",
  );
  const block = document.querySelector("[data-message-block]") as HTMLElement;
  expect(within(block).getByText("Factory")).toBeInTheDocument();
  expect(within(block).getByRole("link", { name: "Task T-2: Second" })).toHaveAttribute(
    "href",
    "/tasks/T-2",
  );
});

test("a pending task message shows its badge in the dashed block", async () => {
  mockApi({
    "GET /api/agents/dev": () =>
      json(
        detail({}, [
          {
            id: "q1",
            kind: "message",
            from: "@factory",
            body: "Pending brief",
            taskKey: "T-9",
            taskTitle: "Queued task",
            createdAt: AT,
          },
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
  const text = await screen.findByText("Pending brief");
  const block = text.closest("[data-message-block]") as HTMLElement;
  expect(block.className).toContain("border-dashed");
  expect(within(block).getByText("Factory")).toBeInTheDocument();
  expect(within(block).getByRole("link", { name: "Task T-9: Queued task" })).toHaveAttribute(
    "href",
    "/tasks/T-9",
  );
});

test("Agent details' open tasks link goes to that agent's tasks", async () => {
  mockApi({
    "GET /api/agents/dev": () => json(detail({ openTasks: 3 })),
    "GET /api/agents/dev/events?": () =>
      json({
        hasMore: { before: false, after: false },
        events: [se({ type: "assistant_text", text: "x" })],
      }),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Agent details" }));
  expect(await screen.findByRole("link", { name: "All 3 tasks" })).toHaveAttribute(
    "href",
    "/tasks?assignee=dev",
  );
});

// ---- U3 §7.2: speaker lines ----
test("200 message rows create no per-row query observers (one speaker index for the session)", async () => {
  const messages = Array.from({ length: 200 }, (_, i) =>
    env({
      id: `m${i}`,
      from: i % 2 ? "b" : "@or",
      kind: "message",
      body: `body ${i}`,
    }),
  );
  await open([{ type: "message_in", messages }], "body 199", {
    "GET /api/users": () =>
      json({
        users: [
          {
            id: "u2",
            name: "Or Levi",
            handle: "or",
            email: "o@x",
            createdAt: AT,
            disabledAt: null,
          },
        ],
      }),
  });
  await screen.findAllByText("Or Levi");
  const observers = (key: readonly unknown[]) =>
    last.qc?.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount() ?? 0;
  // The sidebar, the header and the speaker index read these lists: a fixed few, never one per row.
  expect(observers(["agents", "exclude"])).toBeLessThan(10);
  expect(observers(["agents", "only"])).toBeLessThan(10);
  expect(observers(["users"])).toBeLessThan(10);
  expect(observers(["ended-more"])).toBeLessThan(10);
});

test("your own message says 'You'; a known human shows their name", async () => {
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({ id: "m1", from: "@alice", kind: "message", body: "from me" }),
          env({ id: "m2", from: "@or", kind: "message", body: "from or" }),
        ],
      },
    ],
    "from me",
    {
      "GET /api/users": () =>
        json({
          users: [
            {
              id: "u2",
              name: "Or Levi",
              handle: "or",
              email: "o@x",
              createdAt: AT,
              disabledAt: null,
            },
          ],
        }),
    },
  );
  const [mine, theirs] = [...document.querySelectorAll<HTMLElement>("[data-message-block]")];
  expect(within(mine as HTMLElement).getByText("You")).toBeInTheDocument();
  expect(within(mine as HTMLElement).queryByText("@alice")).toBeNull();
  expect(await within(theirs as HTMLElement).findByText("Or Levi")).toHaveAttribute("dir", "auto");
  for (const b of [mine, theirs])
    expect(b?.querySelector("[data-message-body]")).toHaveAttribute("dir", "auto");
});

test("an outgoing card reads 'Name → Recipient' with the agent's name", async () => {
  await open(
    [
      { type: "turn_started" },
      call({ to: "@alice", body: "ping you" }),
      result(JSON.stringify({ id: "m9", to: "@alice", status: "delivered" })),
    ],
    "ping you",
  );
  const block = screen.getByRole("article", { name: "Message from @dev to @alice" });
  const sender = block.querySelector("[data-speaker-line]") as HTMLElement;
  expect(sender.textContent).toMatch(/^Dev agent@dev.*You\d\d:\d\d$/);
  // The session's own agent is never a link.
  expect(within(sender).queryByRole("link")).toBeNull();
});

test("a task_assigned notice is a quiet line: the factory mark, the badge, two muted clamped lines with Show all", async () => {
  const body =
    "@or assigned you T-1\n\nThe task, written by @or:\n\n> Read this\n\nThen this.\n\nAnd this.";
  await open(
    [
      {
        type: "message_in",
        messages: [
          env({
            id: "t1",
            from: "@factory",
            kind: "task_assigned",
            taskKey: "T-1",
            taskTitle: "Plan the migration",
            body,
          }),
        ],
      },
    ],
    /assigned you T-1/,
  );
  const notice = document.querySelector("[data-notice]") as HTMLElement;
  expect(notice).not.toHaveClass("border");
  expect(notice.querySelector("svg")).not.toBeNull();
  expect(
    within(notice).getByRole("link", { name: "Task T-1: Plan the migration" }),
  ).toBeInTheDocument();
  const shown = notice.querySelector("[data-message-body]") as HTMLElement;
  expect(shown).toHaveClass("text-muted-foreground");
  expect(shown.querySelector(".line-clamp-2")).not.toBeNull();
  await userEvent.click(within(notice).getByRole("button", { name: "Show all" }));
  expect(within(notice).getByText("And this.")).toBeInTheDocument();
  expect(shown.querySelector(".line-clamp-2")).toBeNull();
  expect(within(notice).queryByRole("button", { name: "Show all" })).toBeNull();
});

const notice = (body: string): AnyEvent => ({
  type: "message_in",
  messages: [
    env({
      id: "t1",
      from: "@factory",
      kind: "task_assigned",
      taskKey: "T-1",
      taskTitle: "P",
      body,
    }),
  ],
});

test("a short notice is still two clamped lines; Show all only when it overflows", async () => {
  await open([notice("@or assigned you T-1: a short brief")], /a short brief/);
  const shown = document.querySelector("[data-notice] [data-message-body]") as HTMLElement;
  expect(shown.querySelector(".line-clamp-2")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

test("a notice whose two lines overflow (measured) offers Show all", async () => {
  const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(60);
  const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(36);
  try {
    await open(
      [notice("@or assigned you T-1: one long line that wraps at phone width")],
      /long line/,
    );
    expect(await screen.findByRole("button", { name: "Show all" })).toBeInTheDocument();
  } finally {
    sh.mockRestore();
    ch.mockRestore();
  }
});

test("the users list is fetched alongside the events, not after them (no name pops in later)", async () => {
  const api = mockApi({
    "GET /api/agents/dev": () => json(detail()),
    "GET /api/agents/dev/events?": () => new Promise<Response>(() => {}),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [agentSummary()], running: { count: 1, max: 8 } }),
  });
  renderApp("/agents/dev", alice);
  await vi.waitFor(() => expect(api.calls.some((c) => c.url === "/api/users")).toBe(true));
  expect(document.querySelector("[data-timeline-skeleton]")).not.toBeNull();
});
