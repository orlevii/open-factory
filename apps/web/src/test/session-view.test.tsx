import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail, resetSeq, se } from "@/test/session-fixtures";

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
let routes: Record<string, () => Response>;
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
  expect(within(log).getByText("@or")).toBeInTheDocument();
  expect(within(log).getByText("Urgent")).toBeInTheDocument();
  expect(within(log).getByText("list")).toBeInTheDocument(); // markdown rendered
  expect(log.textContent).not.toMatch(/factory-message/);
  const tool = within(log).getByRole("button", { name: /Bash/ });
  expect(tool).toHaveAttribute("aria-expanded", "false");
  expect(within(log).getByText("ls -la")).toBeInTheDocument();
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

test("working status shows the working line; a status frame removes it", async () => {
  routes["/api/agents/dev"] = () => json(detail({ status: "working", turnOpen: true }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(document.querySelector("[data-working-line]")).toBeInTheDocument();
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
    expect(document.querySelector("[data-working-line]")).not.toBeInTheDocument(),
  );
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
  expect(await screen.findByRole("button", { name: /Jump to latest · 1 new/ })).toBeInTheDocument();
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

test("the deep-link tint stays until a click elsewhere", async () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  const row = document.getElementById("event-5");
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /Bash/ }));
  expect(row).toHaveAttribute("data-highlighted", "true");
  await userEvent.click(screen.getByText("Two entries."));
  expect(row).not.toHaveAttribute("data-highlighted");
});

test("Jump to latest leaves the window and loads the newest page", async () => {
  routes["/api/agents/dev/events?around=5"] = () =>
    json({ ...conversation(), hasMore: { before: true, after: true } });
  const { router } = renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  await userEvent.click(await screen.findByRole("button", { name: /Jump to latest · 0 new/ }));
  await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).not.toBeInTheDocument(),
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

test("window mode: a reconnect resubscribes after the newest counted seq and doesn't double count", async () => {
  windowAround5();
  renderApp("/agents/dev?event=5", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 10 }),
  );
  live(11, { type: "assistant_text", text: "a" });
  live(12, { type: "assistant_text", text: "b" });
  ws.sent = [];
  act(() => ws.reopen());
  await vi.waitFor(() =>
    expect(ws.sent).toContainEqual({ type: "subscribe", agent: "dev", afterSeq: 12 }),
  );
  live(12, { type: "assistant_text", text: "b" }); // replay
  expect(await screen.findByRole("button", { name: "Jump to latest · 2 new" })).toBeInTheDocument();
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
  expect(await screen.findByRole("button", { name: /Jump to latest/ })).toBeInTheDocument();
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
  expect(screen.queryByRole("button", { name: /new event/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
});

test("scrolled up, live rows are counted into the pill (singular, then plural)", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const scroller = screen.getByRole("log", { name: "Session" }).parentElement as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  live(11, { type: "assistant_text", text: "one" });
  expect(await screen.findByRole("button", { name: "1 new event" })).toBeInTheDocument();
  live(12, { type: "assistant_text", text: "two" });
  expect(await screen.findByRole("button", { name: "2 new events" })).toBeInTheDocument();
});

test("pinned to the bottom, a content resize (queued block, working line) keeps it pinned", async () => {
  const observers: (() => void)[] = [];
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
    for (const cb of observers) cb();
  });
  expect(scroller.scrollTop).toBe(900);
});

test("Tab leaves the timeline: only the active row and its Copy link are tabbable; Enter enters a row", async () => {
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
  await userEvent.click(within(log).getByRole("button", { name: /Bash/ })); // expanded: code plates
  const tabbable = () =>
    [...log.querySelectorAll<HTMLElement>("a[href],button,summary,pre,input,[tabindex]")].filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
  await vi.waitFor(() => expect(tabbable().length).toBeLessThanOrEqual(2));
  const first = log.querySelector<HTMLElement>("[data-row]") as HTMLElement;
  first.focus();
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
  expect(document.getElementById("event-10")).toHaveAttribute("data-highlighted", "true");
});

test("Copy link says so inline when the clipboard refuses", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
  });
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const row = document.getElementById("event-7") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Copy link" }));
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
  await userEvent.click(await screen.findByRole("button", { name: /Bash/ }));
  expect(screen.getByText("Truncated (1.2 MB)")).toBeInTheDocument();
});

test("an invalid ?event is ignored", async () => {
  renderApp("/agents/dev?event=abc", alice);
  expect(await screen.findByText("Two entries.")).toBeInTheDocument();
  expect(document.querySelector("[data-highlighted]")).not.toBeInTheDocument();
});

test("a live tool_result flips Running to Failed; nested work shows only when expanded", async () => {
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
  const tool = await screen.findByRole("button", { name: /Task/ });
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
  await userEvent.type(screen.getByRole("textbox", { name: /Message to/ }), "offline hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  const log = screen.getByRole("log", { name: "Session" });
  expect(await within(log).findByText("offline hello")).toBeInTheDocument();
  expect(within(log).getByText("Not delivered yet")).toBeInTheDocument();
});

test("connected: the queue frame is authoritative, so no local row is added", async () => {
  routes["/api/agents/dev/messages"] = accepted("online hello");
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  await userEvent.type(screen.getByRole("textbox", { name: /Message to/ }), "online hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("textbox", { name: /Message to/ })).toHaveValue(""),
  );
  const log = screen.getByRole("log", { name: "Session" });
  expect(within(log).queryByText("online hello")).not.toBeInTheDocument();
});

// --- S4 additions (UI design §4.4) ---

test("strip: slug, template, manager, credential and runtime, identifiers in mono", async () => {
  routes["/api/agents/dev"] = () =>
    json(detail({ slug: "dev", template: "tech-lead", reportsTo: "cto", credential: "work" }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const strip = document.querySelector("[data-agent-strip]") as HTMLElement;
  expect(strip.textContent).toBe(
    "dev·tech-lead·reports to @cto·credential work·Unsandboxed: runs directly on this machine",
  );
  for (const id of ["dev", "tech-lead", "@cto", "work"])
    expect(within(strip).getByText(id)).toHaveClass("font-mono");
});

test("strip: No manager for a root; Docker for docker agents", async () => {
  routes["/api/agents/dev"] = () => json(detail({ reportsTo: null, runtime: "docker" }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  const strip = document.querySelector("[data-agent-strip]") as HTMLElement;
  expect(within(strip).getByText("No manager")).toBeInTheDocument();
  expect(within(strip).getByText("Docker")).toBeInTheDocument();
  expect(strip.textContent).not.toMatch(/Unsandboxed/);
});

test("restart pending: the strip says so with the waiting count; Why? explains in a popover", async () => {
  routes["/api/agents/dev"] = () =>
    json(detail({ restartPending: true, restartWaitingOn: 1, status: "working", turnOpen: true }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(
    screen.getByText("Restarts when idle to apply changes (waiting on 1 background task)"),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Why?" }));
  expect(
    await screen.findByText(
      "The agent finishes its current work, then restarts with the new settings. Its session is kept. Reminders it scheduled in this session are lost.",
    ),
  ).toBeInTheDocument();
});

test("restart pending arrives by frame, plural waiting count; a frame clears it", async () => {
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
  expect(
    await screen.findByText("Restarts when idle to apply changes (waiting on 2 background tasks)"),
  ).toBeInTheDocument();
  frame(true, 0);
  expect(await screen.findByText("Restarts when idle to apply changes")).toBeInTheDocument();
  frame(false, 0);
  await vi.waitFor(() => expect(screen.queryByText(/Restarts when idle/)).not.toBeInTheDocument());
});

test("header: an Edit link to the edit page", async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/agents/dev/edit");
});

test("archived: the composer is replaced by a line linking the edit page; no Compact or Interrupt", async () => {
  routes["/api/agents/dev"] = () => json(detail({ archivedAt: "2026-11-19T10:00:00.000Z" }));
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
  expect(screen.getByText(/This agent is archived\./).textContent).toBe(
    "This agent is archived. Restore it to send messages.",
  );
  expect(screen.getByRole("link", { name: "Restore it" })).toHaveAttribute(
    "href",
    "/agents/dev/edit",
  );
  expect(screen.queryByRole("textbox", { name: /Message to/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Compact/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Interrupt/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Skip to composer")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument();
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
  const read = await screen.findByRole("button", { name: /Read/ });
  expect(within(read).getByText("Denied")).toBeInTheDocument();
  expect(within(read).queryByText("Failed")).not.toBeInTheDocument();
  expect(
    screen.getByText("Denied: Permission to read /etc/x has been denied."),
  ).toBeInTheDocument();
  const bash = screen.getByRole("button", { name: /Bash/ });
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
    "/settings#secrets",
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
    "/settings#credentials",
  );
  expect(screen.getByRole("link", { name: "Open Settings → Projects" })).toHaveAttribute(
    "href",
    "/settings#projects",
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

test("a resume error names pnpm agent:reset-session with the slug", async () => {
  routes["/api/agents/dev/events?"] = errorPage({
    type: "error",
    source: "resume",
    message: "No conversation found",
  });
  renderApp("/agents/dev", alice);
  const hint = await screen.findByText(/To start a new session/);
  expect(hint.textContent).toBe(
    "To start a new session: stop the server, run pnpm agent:reset-session dev, then start it again.",
  );
  expect(within(hint).getByText("pnpm agent:reset-session dev").tagName).toBe("CODE");
  expect(document.body.textContent).not.toMatch(/seed:dev-agent/);
});
