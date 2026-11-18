import type { ServerMessage } from "@open-factory/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail, se } from "@/test/session-fixtures";

const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
  sent: [] as unknown[],
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: {
    onMessage?: (m: ServerMessage) => void;
    onOpen?: () => void;
    onStatus?: (s: string) => void;
  }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return {
      close() {},
      status: () => "open",
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
    ws.onMessage?.({ type: "agent_status", agent: "dev", status: "idle", turnOpen: false }),
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
