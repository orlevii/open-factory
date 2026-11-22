import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, conversation, detail, resetSeq, se } from "@/test/session-fixtures";

const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
  sent: [] as unknown[],
  /** false: the socket never opens (the disconnected case) */
  connects: true,
  reopen: () => {},
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: {
    onMessage?: (m: ServerMessage) => void;
    onOpen?: () => void;
    onStatus?: (s: string) => void;
  }) => {
    ws.onMessage = o.onMessage;
    ws.reopen = () => {
      o.onStatus?.("open");
      o.onOpen?.();
    };
    setTimeout(() => (ws.connects ? ws.reopen() : o.onStatus?.("closed")), 0);
    return {
      close() {},
      status: () => (ws.connects ? "open" : "connecting"),
      send: (m: unknown) => {
        ws.sent.push(m);
        return true;
      },
    };
  },
}));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let routes: Record<string, () => Response | Promise<Response>>;
beforeEach(() => {
  ws.sent = [];
  ws.connects = true;
  routes = {
    "/api/agents/dev": () => json(detail()),
    "/api/agents/dev/events?": () => json(conversation()),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // exact match, or the longest "...?" prefix (so "events?around=5" beats "events?")
      const key = Object.keys(routes)
        .filter((k) => url === k || (k.includes("?") && url.startsWith(k)))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) return json({ error: { code: "not_found", message: url } }, 404);
      return routes[key]?.() ?? json({}, 500);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

test("renders the conversation: sender badge, collapsed tool call, text, compaction marker; never raw XML", async () => {
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  const log = screen.getByRole("log", { name: "Session" });
  // the heading comes from the agent detail; the events are a second request, so wait for the first row
  expect(await within(log).findByText("@or")).toBeInTheDocument();
  expect(within(log).getByText("Urgent")).toBeInTheDocument();
  expect(within(log).getByText("list")).toBeInTheDocument(); // markdown rendered
  expect(log.textContent).not.toMatch(/factory-message/);
  // A Bash row reads "$ command" (U3 §9.2).
  const tool = within(log).getByRole("button", { name: /\$ ls -la/ });
  expect(tool).toHaveAttribute("aria-expanded", "false");
  expect(within(log).queryByText(/README\.md/)).not.toBeInTheDocument();
  await userEvent.click(tool);
  expect(tool).toHaveAttribute("aria-expanded", "true");
  expect(within(log).getByText(/README\.md/)).toBeInTheDocument();
  expect(within(log).getByText("Two entries.")).toBeInTheDocument();
  expect(within(log).getByText("Compacted (manual) · 27.5k → 15.3k tokens")).toBeInTheDocument();
});

test("subscribes from the newest seq and appends live events", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 10 }),
  );
  act(() =>
    ws.onMessage?.({
      type: "session_event",
      agent: "dev",
      event: { ...se({ type: "assistant_text", text: "Live text" }), seq: 11 },
    }),
  );
  expect(await screen.findByText("Live text")).toBeInTheDocument();
});

test("an open turn shows the activity line under the last row, above the queue; a status frame removes it", async () => {
  routes["/api/agents/dev"] = () =>
    json(
      detail({ status: "working", turnOpen: true }, [
        {
          id: "q1",
          kind: "message",
          body: "next up",
          urgent: false,
          from: "@or",
          createdAt: "2026-11-18T10:00:00.000Z",
        },
      ]),
    );
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const line = document.querySelector("[data-activity-line]");
  expect(line).toBeInTheDocument();
  expect(document.querySelector("[data-working-line]")).not.toBeInTheDocument();
  const rows = document.querySelectorAll("[data-row-wrap]");
  const lastRow = rows[rows.length - 1] as Element;
  const queued = screen.getByText("next up");
  // Time order: now, then next.
  expect(
    lastRow.compareDocumentPosition(line as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    (line as Element).compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  act(() =>
    ws.onMessage?.({
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  await vi.waitFor(() =>
    expect(document.querySelector("[data-activity-line]")).not.toBeInTheDocument(),
  );
});

test("no activity line while no turn is open, or in a windowed view", async () => {
  routes["/api/agents/dev"] = () => json(detail({ status: "working", turnOpen: false }));
  const first = renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(document.querySelector("[data-activity-line]")).not.toBeInTheDocument();
  first.unmount();
  routes["/api/agents/dev"] = () => json(detail({ status: "working", turnOpen: true }));
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  expect(document.querySelector("[data-activity-line]")).not.toBeInTheDocument();
});

test("deep link loads a window around the event and highlights it", async () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("around=5"))).toBe(true);
  expect(document.getElementById("event-5")).toHaveAttribute("data-highlighted", "true");
  act(() =>
    ws.onMessage?.({
      type: "session_event",
      agent: "dev",
      event: { ...se({ type: "assistant_text", text: "Later" }), seq: 11 },
    }),
  );
  expect(screen.queryByText("Later")).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "1 new message" })).toHaveAttribute(
    "data-shown",
  );
});

test("a windowed view subscribes from the agent's lastSeq, not the highest seq on screen", async () => {
  routes["/api/agents/dev"] = () => json(detail({}, [], 42));
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 42 }),
  );
  expect(ws.sent).not.toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 10 });
});

test("a deep link focuses its row, and a click elsewhere doesn't take the target away", async () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  const wrap = document.getElementById("event-5") as HTMLElement;
  const row = wrap.querySelector("[data-row]") as HTMLElement;
  await vi.waitFor(() => expect(row).toHaveFocus());
  expect(row).toHaveAttribute("data-arrived");
  await userEvent.click(screen.getByText("Two entries."));
  expect(wrap).toHaveAttribute("data-highlighted", "true");
});

test("Jump to latest leaves the window and loads the newest page", async () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  const { router } = renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  await userEvent.click(await screen.findByRole("button", { name: "Jump to latest" }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  // The newest page is pinned: the pill stays mounted, hidden.
  await vi.waitFor(() =>
    expect(document.querySelector(".jump-pill")).not.toHaveAttribute("data-shown"),
  );
  expect(document.querySelector("[data-highlighted]")).not.toBeInTheDocument();
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
});

test("a missing deep-link event falls back to the latest page with a note", async () => {
  routes["/api/agents/dev/events?around=999"] = () =>
    json({ error: { code: "event_not_found", message: "x" } }, 404);
  renderApp("/agents/dev?event=999", alice);
  expect(
    await screen.findByText("Event 999 isn't in this session. Showing the latest."),
  ).toBeInTheDocument();
  expect(screen.getByText("Two entries.")).toBeInTheDocument();
  expect(document.querySelector("[data-highlighted]")).not.toBeInTheDocument();
});

test("an unknown agent shows the not-found state", async () => {
  routes["/api/agents/dev"] = () => json({ error: { code: "agent_not_found", message: "x" } }, 404);
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("heading", { name: "Page not found." })).toBeInTheDocument();
});

test("queued messages come only from queue frames and say they aren't delivered", async () => {
  routes["/api/agents/dev"] = () =>
    json(
      detail({ status: "errored", lastError: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents" }, [
        {
          id: "q1",
          kind: "message",
          body: "pending body",
          urgent: false,
          from: "@or",
          createdAt: "2026-11-18T10:00:00.000Z",
        },
      ]),
    );
  renderApp("/agents/dev", alice);
  expect(await screen.findByText("pending body")).toBeInTheDocument();
  expect(
    screen.getByText("Not delivered yet: Set CLAUDE_CODE_OAUTH_TOKEN to run agents"),
  ).toBeInTheDocument();
  act(() => ws.onMessage?.({ type: "queue", agent: "dev", items: [] }));
  await vi.waitFor(() => expect(screen.queryByText("pending body")).not.toBeInTheDocument());
});

test("keyboard: the timeline is one tab stop with arrow-key roving focus", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const rows = screen.getByRole("log", { name: "Session" }).querySelectorAll("[data-row]");
  expect([...rows].filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  (rows[0] as HTMLElement).focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(rows[1]);
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(rows[rows.length - 1]);
});

const live = (seq: number, event: Parameters<typeof se>[0]) =>
  act(() => ws.onMessage?.({ type: "session_event", agent: "dev", event: { ...se(event), seq } }));
const windowAround5 = () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
};
const page = (events: ReturnType<typeof se>[], before = false) =>
  json({ events, hasMore: { before, after: false } });

test("a server restart: a reload that hits a 502 keeps the session on screen and retries when the socket is back", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  routes["/api/agents/dev"] = () =>
    json({ error: { code: "bad_gateway", message: "Bad Gateway" } }, 502);
  act(() => ws.onMessage?.({ type: "resync", agent: "dev" }));
  expect(await screen.findByText(/Couldn't load this session/)).toBeInTheDocument();
  expect(screen.getByText("Two entries.")).toBeInTheDocument(); // the last data stays
  expect(screen.queryByRole("heading", { name: "Something went wrong." })).toBeNull();
  routes["/api/agents/dev"] = () => json(detail());
  act(() => ws.reopen());
  await vi.waitFor(() => expect(screen.queryByText(/Couldn't load this session/)).toBeNull());
  expect(screen.getByText("Two entries.")).toBeInTheDocument();
});

test("a first load that fails before the server is back retries itself on reconnect", async () => {
  routes["/api/agents/dev"] = () =>
    json({ error: { code: "bad_gateway", message: "Bad Gateway" } }, 502);
  renderApp("/agents/dev", alice);
  expect(await screen.findByText(/Couldn't load this session/)).toBeInTheDocument();
  routes["/api/agents/dev"] = () => json(detail());
  act(() => ws.reopen());
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  expect(screen.queryByText(/Couldn't load this session/)).toBeNull();
});

test("window mode: a reconnect resubscribes after the newest counted seq and doesn't double count", async () => {
  windowAround5();
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 10 }),
  );
  live(11, { type: "assistant_text", text: "a" });
  live(12, { type: "assistant_text", text: "b" });
  // Frames commit on the next animation frame; a reconnect's backoff is always longer than that.
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  ws.sent = [];
  act(() => ws.reopen());
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 12 }),
  );
  live(12, { type: "assistant_text", text: "b" }); // replay
  expect(await screen.findByRole("button", { name: "2 new messages" })).toHaveAttribute(
    "data-shown",
  );
});

test("a resync while windowed reloads the same window", async () => {
  windowAround5();
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  const arounds = () =>
    vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes("around=5")).length;
  expect(arounds()).toBe(1);
  act(() => ws.onMessage?.({ type: "resync", agent: "dev" }));
  await vi.waitFor(() => expect(arounds()).toBe(2));
  expect(await screen.findByRole("button", { name: "Jump to latest" })).toHaveAttribute(
    "data-shown",
  );
});

test("Load earlier prepends without a new-events pill; a failure says so and a later success clears it", async () => {
  routes["/api/agents/dev/events?"] = () =>
    json({
      ...conversation(),
      events: conversation().events.map((e) => ({ ...e, seq: e.seq + 10 })),
      hasMore: { before: true, after: false },
    });
  routes["/api/agents/dev/events?before=11"] = () =>
    json({ error: { code: "internal", message: "boom" } }, 500);
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("Couldn't load earlier events.")).toBeInTheDocument();
  expect(screen.queryByText(/Couldn't load this session/)).not.toBeInTheDocument();
  resetSeq();
  routes["/api/agents/dev/events?before=11"] = () =>
    page([{ ...se({ type: "assistant_text", text: "Earlier text" }), seq: 3 }]);
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  expect(await screen.findByText("Earlier text")).toBeInTheDocument();
  expect(screen.queryByText("Couldn't load earlier events.")).not.toBeInTheDocument();
  expect(document.querySelector(".jump-pill")).not.toHaveAttribute("data-shown");
  expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
});

test("scrolled up, live rows are counted into the pill (singular, then plural)", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const scroller = screen.getByRole("log", { name: "Session" }).parentElement as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  scroller.scrollTop = 1500; // at the bottom
  fireEvent.scroll(scroller);
  scroller.scrollTop = 100; // the reader scrolls up
  fireEvent.scroll(scroller);
  live(11, { type: "assistant_text", text: "one" });
  expect(await screen.findByRole("button", { name: "1 new message" })).toHaveAttribute(
    "data-shown",
  );
  live(12, { type: "assistant_text", text: "two" });
  expect(await screen.findByRole("button", { name: "2 new messages" })).toHaveAttribute(
    "data-shown",
  );
});

test("pinned to the bottom, a content resize (queued block, working line) keeps it pinned", async () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const scroller = screen.getByRole("log", { name: "Session" }).parentElement as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
  act(() => {
    for (const cb of observers) cb([], {} as ResizeObserver);
  });
  expect(scroller.scrollTop).toBe(900);
});

test("Tab leaves the timeline: only the active row, its controls and its row menu are tabbable; Enter enters a row", async () => {
  routes["/api/agents/dev/events?"] = () => {
    const c = conversation();
    resetSeq();
    return page([
      se(
        {
          type: "message_in",
          messages: [
            {
              id: "m1",
              from: "@or",
              kind: "message",
              urgent: false,
              body: "See [docs](https://example.com)",
            },
          ],
        },
        null,
      ),
      ...c.events.slice(3).map((e) => ({ ...e, seq: e.seq + 1 })),
      {
        ...se({ type: "assistant_text", text: "More at [site](https://example.org)" }),
        seq: 20,
      },
    ]);
  };
  renderApp("/agents/dev", alice);
  await screen.findByText("docs");
  const log = screen.getByRole("log", { name: "Session" });
  await userEvent.click(within(log).getByRole("button", { name: /ls -la/ })); // expanded: code plates
  const tabbable = () =>
    [...log.querySelectorAll<HTMLElement>("a[href],button,summary,pre,input,[tabindex]")].filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
  const first = log.querySelector<HTMLElement>("[data-row]") as HTMLElement;
  first.focus(); // the click made the Bash row active; the first row is active from here
  // The active row, its own controls (UI design §5) and its row menu; every other row's controls
  // (the expanded code plates, the later link) stay out of the tab order.
  await vi.waitFor(() => expect(tabbable().length).toBeLessThanOrEqual(3));
  expect(within(log).getByRole("link", { name: "site" })).toHaveAttribute("tabindex", "-1");
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "docs" }));
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(first);
});

test("a deep link to a seq without its own row tints the nearest later row", async () => {
  routes["/api/agents/dev/events?around=8"] = () =>
    json({ ...conversation(), hasMore: { before: false, after: false } });
  renderApp("/agents/dev?event=8", alice); // seq 8 is `usage`, not rendered
  await screen.findByText("Two entries.");
  // The turn's footer (the turn_end, seq 9) is the nearest later row.
  expect(document.getElementById("event-9")).toHaveAttribute("data-highlighted", "true");
});

test("Copy link says so inline when the clipboard refuses", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
  });
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const row = document.getElementById("event-7") as HTMLElement;
  fireEvent.pointerDown(within(row).getByRole("button", { name: "Row actions" }), { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(await within(row).findByText("Couldn't copy")).toBeInTheDocument();
});

test("a capped tool input shows its truncation note", async () => {
  routes["/api/agents/dev/events?"] = () => {
    resetSeq();
    return page([
      se({ type: "turn_started" }),
      {
        ...se({ type: "tool_call", toolUseId: "tu1", name: "Bash", input: { command: "echo" } }),
        truncated: { "input.command": 1_200_000 },
      },
    ]);
  };
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: /echo/ }));
  expect(screen.getByText("Truncated (1.2 MB)")).toBeInTheDocument();
});

test("an invalid ?event is ignored", async () => {
  renderApp("/agents/dev?event=abc", alice);
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
  expect(document.querySelector("[data-highlighted]")).not.toBeInTheDocument();
});

test("a live tool_result flips a subagent from Running to Failed; nested work shows only when expanded", async () => {
  routes["/api/agents/dev/events?"] = () => {
    resetSeq();
    return page([
      se({ type: "turn_started" }),
      se({ type: "tool_call", toolUseId: "tu1", name: "Task", input: { description: "scan" } }),
      se({ type: "assistant_text", text: "nested voice", parentToolUseId: "tu1" }),
    ]);
  };
  routes["/api/agents/dev"] = () => json(detail({ status: "working", turnOpen: true }, [], 3));
  renderApp("/agents/dev", alice);
  const tool = await screen.findByRole("button", { name: /Subagent in this session/ });
  expect(within(tool).getByText("Running")).toBeInTheDocument();
  expect(screen.queryByText("nested voice")).not.toBeInTheDocument();
  await userEvent.click(tool);
  expect(screen.getByText("nested voice")).toBeInTheDocument();
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 3 }),
  );
  live(4, { type: "tool_result", toolUseId: "tu1", content: "bad", isError: true });
  expect(await within(tool).findByText("Failed")).toBeInTheDocument();
});

const accepted = (body: string) => () =>
  json(
    {
      item: {
        id: "q9",
        kind: "message",
        body,
        urgent: false,
        from: "@alice",
        createdAt: "2026-11-18T10:00:00.000Z",
      },
    },
    202,
  );

test("disconnected: an accepted message shows as queued at once", async () => {
  ws.connects = false;
  routes["/api/agents/dev/messages"] = accepted("offline hello");
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  await userEvent.type(screen.getByRole("combobox", { name: /Message to/ }), "offline hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  const log = screen.getByRole("log", { name: "Session" });
  expect(await within(log).findByText("offline hello")).toBeInTheDocument();
  // Not at once: an item younger than 300ms doesn't say so (U3 §13.2).
  expect(within(log).queryByText("Not delivered yet")).toBeNull();
  expect(await within(log).findByText("Not delivered yet")).toBeInTheDocument();
});

test("connected: the 202's item replaces the Sending block, once (U3 §13.2)", async () => {
  routes["/api/agents/dev/messages"] = accepted("online hello");
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  await userEvent.type(screen.getByRole("combobox", { name: /Message to/ }), "online hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  const log = screen.getByRole("log", { name: "Session" });
  await vi.waitFor(() => expect(within(log).queryByRole("group", { name: "Sending" })).toBeNull());
  expect(within(log).getAllByText("online hello")).toHaveLength(1);
});

// --- S4 additions (UI design §4.4) ---

test("header: avatar without badge, name, StatusBadge, one live fact, no Stop (it is in the composer), ⋯", async () => {
  routes["/api/agents/dev"] = () =>
    json(
      detail({
        status: "working",
        turnOpen: true,
        restartPending: true,
        waitingOn: {
          tasks: [
            { taskId: "t1", description: "pnpm test", startedAt: "2026-11-18T10:00:00.000Z" },
          ],
          crons: 0,
        },
      }),
    );
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const header = screen.getByRole("banner");
  expect(within(header).getByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  // The avatar is decorative and carries no status badge (the badge beside it does).
  const avatar = header.querySelector("[data-agent-avatar]");
  expect(avatar).not.toBeNull();
  expect(avatar).toHaveAttribute("aria-hidden", "true");
  expect(avatar?.querySelector(".of-avatar-cut")).toBeNull();
  expect(within(header).getAllByText("Working").length).toBeGreaterThan(0);
  // One fact only: restart pending beats the waiting task.
  const facts = within(header)
    .getAllByRole("status")
    .filter((s) => s.textContent);
  expect(facts.map((f) => f.textContent)).toEqual(["Restarts when idle"]);
  expect(within(header).queryByRole("button", { name: /Stop|Interrupt/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(within(header).getByRole("button", { name: "Actions for Dev agent" })).toBeInTheDocument();
  // Edit, Compact and Terminate live in the ⋯ menu now.
  expect(within(header).queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  expect(within(header).queryByRole("button", { name: /Compact/ })).not.toBeInTheDocument();
});

test("header: no Stop while no turn is open; Restart when errored, its failure a notice row below the header", async () => {
  routes["/api/agents/dev"] = () =>
    json(detail({ status: "errored", lastError: "Boom\nmore", errorKind: "crash" }));
  routes["/api/agents/dev/restart"] = () =>
    json({ error: { code: "restart_failed", message: "No slot." } }, 500);
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const header = screen.getByRole("banner");
  expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  expect(within(header).getByText("Boom")).toBeInTheDocument();
  await userEvent.click(within(header).getByRole("button", { name: "Restart" }));
  const alert = await screen.findByText(/Couldn't restart: No slot\./);
  expect(header.contains(alert)).toBe(false);
  // Leaving Errored clears it: a later error doesn't bring back the old failure.
  const frame = (status: "idle" | "errored") =>
    act(() =>
      ws.onMessage?.({
        type: "agent_status",
        agent: "dev",
        status,
        turnOpen: false,
        restartPending: false,
        restartWaitingOn: 0,
      }),
    );
  frame("idle");
  await vi.waitFor(() => expect(screen.queryByText(/Couldn't restart/)).not.toBeInTheDocument());
  frame("errored");
  await vi.waitFor(() =>
    expect(within(header).getByRole("button", { name: "Restart" })).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Couldn't restart/)).not.toBeInTheDocument();
});

test("header: a terminated agent's Pin is its own button, outside the live line", async () => {
  routes["/api/agents/dev"] = () =>
    json(
      detail({
        kind: "ephemeral",
        status: "terminated",
        terminatedAt: "2026-11-18T09:00:00.000Z",
        terminatedBy: "lead",
        workspaceGraceEndsAt: "2099-11-21T09:00:00.000Z",
      }),
    );
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const header = screen.getByRole("banner");
  const pin = within(header).getByRole("button", { name: /Pin workspace/ });
  const line = within(header)
    .getAllByRole("status")
    .find((s) => s.textContent?.startsWith("Terminated by @lead"));
  expect(line).toBeDefined();
  expect(line?.contains(pin)).toBe(false);
});

test("no strip: 'Reports to' no longer renders under the header", async () => {
  routes["/api/agents/dev"] = () => json(detail({ reportsTo: "cto" }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(document.querySelector("[data-agent-strip]")).toBeNull();
  // Agent details is closed by default below 1280px, and the header carries no org segment.
  expect(screen.queryByText(/Reports to/)).not.toBeInTheDocument();
});

test("restart pending arrives by frame; a frame clears it", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(screen.queryByText(/Restarts when idle/)).not.toBeInTheDocument();
  const frame = (restartPending: boolean, restartWaitingOn: number) =>
    act(() =>
      ws.onMessage?.({
        type: "agent_status",
        agent: "dev",
        status: "working",
        turnOpen: true,
        restartPending,
        restartWaitingOn,
      }),
    );
  frame(true, 2);
  expect(await screen.findByText("Restarts when idle")).toBeInTheDocument();
  frame(false, 0);
  await vi.waitFor(() => expect(screen.queryByText(/Restarts when idle/)).not.toBeInTheDocument());
});

test("archived: the composer is replaced by a notice with a Restore button; no Compact or Stop", async () => {
  routes["/api/agents/dev"] = () => json(detail({ archivedAt: "2026-11-19T10:00:00.000Z" }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(screen.getByText(/This agent is archived\./).textContent).toBe(
    "This agent is archived. Restore it to send messages.",
  );
  expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Restore it" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /Message to/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Compact/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Skip to composer")).not.toBeInTheDocument();
});

test("archived: Restore restores in place and the composer comes back", async () => {
  let archived = true;
  routes["/api/agents/dev"] = () =>
    json(detail({ archivedAt: archived ? "2026-11-19T10:00:00.000Z" : null }));
  routes["/api/agents/dev/unarchive"] = () => {
    archived = false;
    return json({ agent: agentSummary() });
  };
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
  await vi.waitFor(() =>
    expect(screen.queryByText(/This agent is archived\./)).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("combobox", { name: /Message to/ })).toBeInTheDocument();
});

test("archived: a refused Restore says why inline, and the button stays", async () => {
  routes["/api/agents/dev"] = () => json(detail({ archivedAt: "2026-11-19T10:00:00.000Z" }));
  routes["/api/agents/dev/unarchive"] = () =>
    json(
      {
        error: {
          code: "manager_archived",
          message: "Its manager @boss is archived. Change its manager first.",
        },
      },
      409,
    );
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Restore" }));
  const line = await screen.findByText(
    "Couldn't restore @dev: Its manager @boss is archived. Change its manager first.",
  );
  expect(line.closest("[role=alert]")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
});

test("archived: Restore from the session's menu restores, toasts, and brings the composer back", async () => {
  let archived = true;
  routes["/api/agents/dev"] = () =>
    json(detail({ archivedAt: archived ? "2026-11-19T10:00:00.000Z" : null }));
  routes["/api/agents/dev/unarchive"] = () => {
    archived = false;
    return json({ agent: agentSummary() });
  };
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Actions for Dev agent" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
  expect(await screen.findByText("Restored @dev.")).toBeInTheDocument();
  await vi.waitFor(() =>
    expect(screen.queryByText(/This agent is archived\./)).not.toBeInTheDocument(),
  );
});

test("Archive from the session's menu swaps the composer for the archived notice", async () => {
  let archived = false;
  routes["/api/agents/dev"] = () =>
    json(detail({ archivedAt: archived ? "2026-11-19T10:00:00.000Z" : null }));
  routes["/api/agents/dev/archive"] = () => {
    archived = true;
    return json({ agent: agentSummary({ archivedAt: "2026-11-19T10:00:00.000Z" }) });
  };
  renderApp("/agents/dev", alice);
  await userEvent.click(await screen.findByRole("button", { name: "Actions for Dev agent" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Archive…" }));
  expect(await screen.findByText("Archived @dev.")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
});

test("archived with no events: the empty line doesn't point at a composer", async () => {
  routes["/api/agents/dev"] = () => json(detail({ archivedAt: "2026-11-19T10:00:00.000Z" }));
  routes["/api/agents/dev/events?"] = () => page([]);
  renderApp("/agents/dev", alice);
  expect(await screen.findByText("No messages yet.")).toBeInTheDocument();
  expect(screen.queryByText(/Send the first one below/)).not.toBeInTheDocument();
});

test("a paired denial shows inside its call: Denied state and the reason line; no standalone row", async () => {
  routes["/api/agents/dev/events?"] = () => {
    resetSeq();
    return page([
      se({ type: "turn_started" }),
      se({ type: "tool_call", toolUseId: "tu1", name: "Read", input: { file_path: "/etc/x" } }),
      se({
        type: "permission_denied",
        toolName: "Read",
        toolUseId: "tu1",
        reasonType: "rule",
        reason: "Permission to read /etc/x has been denied.",
      }),
      se({ type: "tool_result", toolUseId: "tu1", content: "denied", isError: true }),
      se({ type: "tool_call", toolUseId: "tu2", name: "Bash", input: { command: "rm -rf x" } }),
      se({
        type: "permission_denied",
        toolName: "Bash",
        toolUseId: "tu2",
        reasonType: "subcommandResults",
        reason: "",
      }),
      se({ type: "turn_end", isError: false, numTurns: 1 }),
    ]);
  };
  routes["/api/agents/dev"] = () => json(detail({}, [], 7));
  renderApp("/agents/dev", alice);
  // A Read row names its file, not the tool (spec §9.2); the full path is the name's title.
  const read = (await screen.findByTitle("/etc/x")).closest("button") as HTMLElement;
  expect(within(read).getByText("Denied")).toBeInTheDocument();
  expect(within(read).queryByText("Failed")).not.toBeInTheDocument();
  expect(
    screen.getByText("Denied: Permission to read /etc/x has been denied."),
  ).toBeInTheDocument();
  const bash = screen.getByRole("button", { name: /rm -rf x/ });
  expect(within(bash).getByText("Denied")).toBeInTheDocument();
  expect(screen.getByText("Denied by a permission rule")).toBeInTheDocument();
  expect(screen.queryByText(/^Denied: Read$/)).not.toBeInTheDocument();
});

const errorPage = (event: Parameters<typeof se>[0]) => () => {
  resetSeq();
  return page([se(event, null)]);
};

test("an error with fix secrets links to Settings → Secrets", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "spawn",
    message: "The secret GH_TOKEN isn't set. Add it in Settings → Secrets.",
    code: "secret_missing",
    fix: "secrets",
  });
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("link", { name: "Open Settings → Secrets" })).toHaveAttribute(
    "href",
    "/settings/secrets",
  );
});

test("an error with fix credentials or projects links to that section", async () => {
  routes["/api/agents/dev/events?"] = () => {
    resetSeq();
    return page([
      se({ type: "error", source: "spawn", message: "a", fix: "credentials" }, null),
      se({ type: "error", source: "spawn", message: "b", fix: "projects" }, null),
    ]);
  };
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("link", { name: "Open Settings → Credentials" })).toHaveAttribute(
    "href",
    "/settings/credentials",
  );
  expect(screen.getByRole("link", { name: "Open Settings → Projects" })).toHaveAttribute(
    "href",
    "/settings/projects",
  );
});

test("an error with fix image links to Templates → Images", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "spawn",
    message:
      "Image `playwright` isn't built. Build it in Templates → Images, or run `open-factory images build playwright`.",
    fix: "image",
  });
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("link", { name: "Open Templates → Images" })).toHaveAttribute(
    "href",
    "/templates/images",
  );
});

test("an error with fix edit_agent links to the edit page", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "spawn",
    message: "The host skill x is missing.",
    fix: "edit_agent",
  });
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("link", { name: "Edit the agent" })).toHaveAttribute(
    "href",
    "/agents/dev/edit",
  );
});

test("an error with fix resync runs the agent's Re-sync in place", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "spawn",
    message: "Re-sync @dev to reinstall its plugins into the factory-managed location.",
    fix: "resync",
  });
  let resynced = 0;
  routes["/api/agents/dev/resync"] = () => {
    resynced++;
    return json({ agent: agentSummary(), applied: "now" });
  };
  renderApp("/agents/dev", alice);
  const fix = await screen.findByRole("button", { name: "Re-sync the agent" });
  expect(screen.queryByRole("link", { name: "Re-sync the agent" })).not.toBeInTheDocument();
  await userEvent.click(fix);
  expect(await screen.findByText("Re-synced. Nothing differed.")).toBeInTheDocument();
  expect(resynced).toBe(1);
});

test("a resume error no longer names the interim reset script", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "resume",
    message: "No conversation found",
  });
  renderApp("/agents/dev", alice);
  expect(await screen.findByText("No conversation found")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/agent:reset-session|stop the server/);
  expect(document.body.textContent).not.toMatch(/seed:dev-agent/);
});

test("the log and each row wrap can shrink, so no row widens the scroller", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByRole("heading", { level: 1, name: "Dev agent" });
  const log = screen.getByRole("log", { name: "Session" });
  expect(log).toHaveClass("min-w-0");
  const wraps = log.querySelectorAll("[data-row-wrap]");
  expect(wraps.length).toBeGreaterThan(0);
  for (const w of wraps) expect(w).toHaveClass("min-w-0");
});

test("the Stop button uses the stop glyph", async () => {
  routes["/api/agents/dev"] = () => json(detail({ status: "working", turnOpen: true }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const icon = screen.getByRole("button", { name: "Stop" }).querySelector("svg");
  expect(icon).toHaveClass("lucide-circle-stop");
});

/** A response the test releases by hand; every request before or after the release gets a copy. */
function held() {
  let release: (r: Response) => void = () => {};
  const gate = new Promise<Response>((r) => {
    release = r;
  });
  return { respond: () => gate.then((r) => r.clone()), release };
}
const requested = (part: string) =>
  vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes(part)).length;
const listed = () => json({ agents: [agentSummary()], more: false, running: { count: 0, max: 8 } });

test("with the agents list cached, the session renders its header from the summary while the detail loads", async () => {
  routes["/api/agents?"] = listed;
  const gate = held();
  routes["/api/agents/dev"] = gate.respond;
  renderApp("/agents", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Dev agent/ }));
  // No route pending screen: the header and strip come from the list's summary.
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  expect(document.querySelector("[data-timeline-skeleton] [data-slot=skeleton]")).not.toBeNull();
  // Plain visit: the events page is requested alongside the detail, not after it.
  await vi.waitFor(() => expect(requested("/api/agents/dev/events?")).toBe(1));
  gate.release(json(detail()));
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
  expect(document.querySelector("[data-timeline-skeleton]")).not.toBeInTheDocument();
});

test("with nothing cached, the route still waits for the detail", async () => {
  const gate = held();
  routes["/api/agents/dev"] = gate.respond;
  renderApp("/agents/dev", alice);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(screen.queryByRole("heading", { level: 1, name: "Dev agent" })).not.toBeInTheDocument();
  expect(requested("/api/agents/dev/events?")).toBe(0);
  gate.release(json(detail()));
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
});

test("a cold load renders from the detail the route waited for while the session reads it again", async () => {
  // The loader's GET answers; the view's own fresh read (for lastSeq) is held.
  const gate = held();
  let calls = 0;
  routes["/api/agents/dev"] = () => (++calls === 1 ? json(detail()) : gate.respond());
  renderApp("/agents/dev", alice);
  expect(await screen.findByRole("heading", { level: 1, name: "Dev agent" })).toBeInTheDocument();
  await vi.waitFor(() => expect(detailRequests()).toBe(2));
  expect(document.querySelector("[data-timeline-skeleton] [data-slot=skeleton]")).not.toBeNull();
  await userEvent.type(screen.getByRole("combobox", { name: "Message to Dev agent" }), "early");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  gate.release(json(detail()));
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  localStorage.removeItem("of-draft:v1:agent:dev"); // the unsent draft would carry into the next test
});

test("a cached summary whose agent turns out not to exist shows Agent not found", async () => {
  routes["/api/agents?"] = listed;
  routes["/api/agents/dev"] = () => json({ error: { code: "agent_not_found", message: "x" } }, 404);
  renderApp("/agents", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Dev agent/ }));
  expect(await screen.findByRole("heading", { name: "Agent not found." })).toBeInTheDocument();
});

test("?message= resolves the message before asking for the events window", async () => {
  routes["/api/agents/dev/events?around=5"] = () => json(conversation());
  const gate = held();
  routes["/api/messages/m1"] = gate.respond;
  renderApp("/agents/dev?message=m1", alice);
  await vi.waitFor(() => expect(requested("/api/messages/m1")).toBe(1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(requested("/api/agents/dev/events?")).toBe(0);
  gate.release(
    json({
      id: "m1",
      kind: "message",
      from: "b",
      to: "dev",
      state: "delivered",
      recipientEvent: { agentSlug: "dev", seq: 5 },
    }),
  );
  await vi.waitFor(() => expect(requested("around=5")).toBe(1));
});

const detailRequests = () =>
  vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === "/api/agents/dev").length;
/** Hover intent: the router preloads after its delay. */
const hover = async (link: HTMLElement) => {
  fireEvent.mouseEnter(link);
  fireEvent.focus(link);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
  fireEvent.mouseLeave(link);
  fireEvent.blur(link);
};

test("hovering a cached agent's link fetches its detail once, however often; the click's view fetches it fresh", async () => {
  routes["/api/agents?"] = listed;
  const { router } = renderApp("/agents", alice);
  const link = await screen.findByRole("link", { name: /Dev agent/ });
  await hover(link);
  await hover(link);
  expect(detailRequests()).toBe(1);
  fireEvent.click(link);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/agents/dev"));
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
  // The hover's warm-up, then the session's own fresh read (for lastSeq): never one per hover.
  expect(detailRequests()).toBe(2);
});

test("a stale list status turning into the loaded one is not announced", async () => {
  routes["/api/agents?"] = () =>
    json({
      agents: [agentSummary({ status: "working", turnOpen: true })],
      more: false,
      running: { count: 1, max: 8 },
    });
  renderApp("/agents", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Dev agent/ }));
  await screen.findByText("Two entries.");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(screen.queryByText(/Dev agent is idle/)).not.toBeInTheDocument();
});

test("the composer can't send until the session has loaded", async () => {
  routes["/api/agents?"] = listed;
  const gate = held();
  routes["/api/agents/dev"] = gate.respond;
  renderApp("/agents", alice);
  await userEvent.click(await screen.findByRole("link", { name: /Dev agent/ }));
  const box = await screen.findByRole("combobox", { name: "Message to Dev agent" });
  await userEvent.type(box, "early");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await userEvent.type(box, "{Enter}");
  expect(vi.mocked(fetch).mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
  gate.release(json(detail()));
  await screen.findByText("Two entries.");
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(box).toHaveValue("early");
});

test("?event= asks for its window only after the detail", async () => {
  routes["/api/agents?"] = listed;
  routes["/api/agents/dev/events?around=5"] = () => json(conversation());
  const gate = held();
  routes["/api/agents/dev"] = gate.respond;
  const { router } = renderApp("/agents", alice);
  await screen.findByRole("link", { name: /Dev agent/ });
  await act(() =>
    router.navigate({ to: "/agents/$slug", params: { slug: "dev" }, search: { event: 5 } }),
  );
  await screen.findByRole("heading", { level: 1, name: "Dev agent" });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(requested("/api/agents/dev/events?")).toBe(0);
  gate.release(json(detail()));
  await vi.waitFor(() => expect(requested("around=5")).toBe(1));
  expect(requested("/api/agents/dev/events?")).toBe(1);
});
