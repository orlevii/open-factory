import type { AgentSummary, QueueItem, ServerMessage } from "@open-factory/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail, resetSeq, se } from "@/test/session-fixtures";

const ws = vi.hoisted(() => ({ onMessage: undefined as undefined | ((m: ServerMessage) => void) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    ws.onMessage = o.onMessage;
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

// Reset times are local wall-clock times: pin "now" so "today 14:30" never crosses midnight.
const NOW = new Date(2026, 10, 19, 10, 0);
const todayAt = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();

let api: MockApi;
const world = (over: Partial<AgentSummary> = {}, queue: QueueItem[] = []) => {
  api = mockApi({
    "GET /api/agents/dev": () => json(detail(over, queue)),
    "GET /api/agents/dev/events?": () => json(conversation()),
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [detail(over).agent], running: { count: 8, max: 8 } }),
  });
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = async () => {
  renderApp("/agents/dev", alice);
  await screen.findByText("Two entries.");
};
const push = (m: ServerMessage) => act(() => ws.onMessage?.(m));
const frame = (over: Partial<Extract<ServerMessage, { type: "agent_status" }>>) =>
  push({
    type: "agent_status",
    agent: "dev",
    status: "idle",
    turnOpen: false,
    restartPending: false,
    restartWaitingOn: 0,
    ...over,
  });
const composer = () => screen.getByRole("textbox", { name: "Message to Dev agent" });

test("errored: Restart and Start a new session replace Compact/Interrupt", async () => {
  world({ status: "errored", errorKind: "resume", lastError: "Resume failed" });
  await open();
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start a new session" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Compact/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Interrupt/ })).not.toBeInTheDocument();
  // Leaving Errored brings Compact and Interrupt back and removes both recovery actions.
  frame({ status: "working", turnOpen: true });
  expect(await screen.findByRole("button", { name: /Interrupt/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start a new session" })).not.toBeInTheDocument();
});

test("a crash offers Restart only", async () => {
  world({ status: "errored", errorKind: "crash" });
  await open();
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start a new session" })).not.toBeInTheDocument();
});

test("Restart hidden for resume_unrecoverable and when runtimeDisabled", async () => {
  world({ status: "errored", errorKind: "resume_unrecoverable", lastError: "No conversation" });
  await open();
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start a new session" })).toBeInTheDocument();
  expect(screen.getByText("Messages wait until a new session is started.")).toBeInTheDocument();
  frame({
    status: "errored",
    errorKind: "crash",
    runtimeDisabled: "The local runtime is disabled on this factory.",
  });
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Start a new session" })).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  expect(screen.queryByText("Messages wait until a new session is started.")).toBeNull();
});

test("Restart posts, reads Restarting… and moves focus to the composer", async () => {
  world({ status: "errored", errorKind: "crash" });
  api.on("POST /api/agents/dev/restart", () => json({}, 202));
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  const pending = await screen.findByRole("button", { name: "Restarting…" });
  expect(pending).toHaveAttribute("aria-disabled", "true");
  expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/agents/dev/restart")).toBe(
    true,
  );
  await vi.waitFor(() => expect(composer()).toHaveFocus());
  frame({ status: "queued" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: /Restart/ })).not.toBeInTheDocument(),
  );
});

test("Restarting… ends on the next error event (failed restart)", async () => {
  world({ status: "errored", errorKind: "crash" });
  api.on("POST /api/agents/dev/restart", () => json({}, 202));
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  await screen.findByRole("button", { name: "Restarting…" });
  push({
    type: "session_event",
    agent: "dev",
    event: { ...se({ type: "error", source: "spawn", message: "Couldn't start" }, null), seq: 11 },
  });
  expect(await screen.findByRole("button", { name: "Restart" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Restart: a 409 not_errored is ignored silently; other failures say so inline", async () => {
  world({ status: "errored", errorKind: "crash" });
  api.on("POST /api/agents/dev/restart", () =>
    json({ error: { code: "not_errored", message: "@dev isn't errored." } }, 409),
  );
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Restart" })).not.toHaveAttribute("aria-disabled"),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  api.on("POST /api/agents/dev/restart", () =>
    json({ error: { code: "attempt_in_progress", message: "A restart is already running." } }, 409),
  );
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't restart: A restart is already running.",
  );
});

test("dialog copy names the agent and the loss; Cancel focused; confirm moves focus to the composer", async () => {
  world({
    slug: "dev",
    status: "errored",
    errorKind: "resume_unrecoverable",
    lastError: "No conversation found with session ID 1234",
  });
  api.on("POST /api/agents/dev/reset-session", () => json({}, 202));
  await open();
  const trigger = screen.getByRole("button", { name: "Start a new session" });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("alertdialog", {
    name: "Start a new session for @dev?",
  });
  expect(
    within(dialog).getByText(
      "@dev won't remember anything from its current session. The history stays visible here, its files are kept, and waiting messages become its first turn.",
    ),
  ).toBeInTheDocument();
  const detailLine = within(dialog).getByText("No conversation found with session ID 1234");
  expect(detailLine).toHaveClass("font-mono");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  // Cancel returns focus to the button that opened it.
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(trigger).toHaveFocus());
  expect(api.calls.some((c) => c.url.endsWith("/reset-session"))).toBe(false);

  await userEvent.click(trigger);
  const again = await screen.findByRole("alertdialog");
  await userEvent.click(within(again).getByRole("button", { name: "Start new session for @dev" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(
    api.calls.some((c) => c.method === "POST" && c.url === "/api/agents/dev/reset-session"),
  ).toBe(true);
  await vi.waitFor(() => expect(composer()).toHaveFocus());
});

test("a confirmed reset whose status frame beats the response still closes the dialog and focuses the composer", async () => {
  world({ status: "errored", errorKind: "resume", lastError: "Resume failed" });
  let stillOpen = false;
  // The server publishes the new status inside the job, before it replies 202.
  api.on("POST /api/agents/dev/reset-session", async () => {
    frame({ status: "queued" });
    // Let the frame render (the recovery buttons go) before the response lands. `hidden`: the modal
    // hides the page from the accessibility tree, which would make this pass before the frame lands.
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Start a new session", hidden: true }),
      ).toBeNull(),
    );
    // The dialog outlives its button: it is still open (pending), so it can close properly.
    stillOpen = screen.queryByRole("alertdialog") !== null;
    return json({}, 202);
  });
  await open();
  await userEvent.click(screen.getByRole("button", { name: "Start a new session" }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Start new session for @dev" }));
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(stillOpen).toBe(true);
  expect(screen.queryByRole("button", { name: "Start a new session" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(composer()).toHaveFocus());
});

test("announcer and document title follow status frames; a no-op until change says nothing new", async () => {
  world();
  await open();
  expect(document.title).toBe("Idle · Dev agent · Open Factory");
  const live = () =>
    screen
      .getAllByRole("status")
      .find(
        (el) => el.getAttribute("aria-live") === "polite" && el.classList.contains("sr-only"),
      ) as HTMLElement;
  frame({ status: "rate_limited", rateLimitedUntil: todayAt(14, 30), rateLimitExact: false });
  await vi.waitFor(() =>
    expect(live()).toHaveTextContent("Dev agent is rate-limited, retrying at 14:30"),
  );
  expect(document.title).toBe("Rate-limited · Dev agent · Open Factory");
  frame({ status: "rate_limited", rateLimitedUntil: todayAt(15, 0), rateLimitExact: false });
  await vi.waitFor(() =>
    expect(screen.getByText("Rate-limited, retrying at 15:00")).toBeInTheDocument(),
  );
  expect(live()).toHaveTextContent("Dev agent is rate-limited, retrying at 14:30");
  frame({ status: "hibernated" });
  await vi.waitFor(() => expect(live()).toHaveTextContent("Dev agent is hibernated"));
  frame({ status: "errored", errorKind: "crash" });
  await vi.waitFor(() => expect(live()).toHaveTextContent("Dev agent is errored"));
  expect(document.title).toBe("Errored · Dev agent · Open Factory");
});

test("header: the queued fact uses the slot cap from the agents list; Pulling the image… wins", async () => {
  world({ status: "queued", runtime: "docker" });
  await open();
  const header = screen.getByRole("banner");
  expect(await within(header).findByText("All 8 slots are in use.")).toBeInTheDocument();
  push({ type: "supervisor", running: 6, max: 6 });
  expect(await within(header).findByText("All 6 slots are in use.")).toBeInTheDocument();
  frame({ status: "queued", pulling: true });
  expect(await within(header).findByText("Pulling the image…")).toBeInTheDocument();
  expect(within(header).queryByText(/slots are in use/)).not.toBeInTheDocument();
});

test("queued blocks: rate-limited (fallback) and waiting for a free slot", async () => {
  const item: QueueItem = {
    id: "q1",
    kind: "message",
    body: "pending body",
    urgent: false,
    from: "@or",
    createdAt: "2026-11-19T09:00:00.000Z",
  };
  world({ status: "rate_limited", rateLimitedUntil: todayAt(14, 30), rateLimitExact: false }, [
    item,
  ]);
  await open();
  expect(
    screen.getByText("Not delivered yet: rate-limited, retrying at 14:30"),
  ).toBeInTheDocument();
  frame({ status: "rate_limited", rateLimitedUntil: todayAt(14, 30), rateLimitExact: true });
  expect(
    await screen.findByText("Not delivered yet: rate-limited until 14:30"),
  ).toBeInTheDocument();
  frame({ status: "queued" });
  expect(await screen.findByText("Not delivered yet: waiting for a free slot")).toBeInTheDocument();
});

test("Factory notice: sender 'Factory', icon aria-hidden, never announced", async () => {
  const notice: QueueItem = {
    id: "n1",
    kind: "notice",
    body: "Restarted by @or after an error.",
    from: "@factory",
    createdAt: "2026-11-19T09:00:00.000Z",
  };
  world({ status: "queued" }, [notice]);
  mockEvents([
    se(
      {
        type: "message_in",
        messages: [
          {
            id: "m9",
            from: "@factory",
            kind: "system",
            urgent: true,
            body: "Your previous process stopped unexpectedly.",
          },
        ],
      },
      null,
    ),
  ]);
  renderApp("/agents/dev", alice);
  const delivered = await screen.findByText("Your previous process stopped unexpectedly.");
  const block = delivered.closest("[data-message-block]") as HTMLElement;
  const sender = within(block).getByText("Factory");
  expect(sender).not.toHaveClass("font-mono");
  expect(block.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(within(block).queryByText("Urgent")).not.toBeInTheDocument();
  expect(block.textContent).not.toMatch(/@factory/);
  // The queued notice is a dashed "Not delivered yet" block with the same sender.
  const queued = screen
    .getByText("Restarted by @or after an error.")
    .closest("[data-message-block]") as HTMLElement;
  expect(within(queued).getByText("Factory")).toBeInTheDocument();
  expect(within(queued).getByText(/Not delivered yet/)).toBeInTheDocument();
  expect(queued.className).toMatch(/border-dashed/);
  for (const region of screen.getAllByRole("status"))
    expect(region.textContent).not.toMatch(/stopped unexpectedly|Restarted by/);
});

const mockEvents = (events: ReturnType<typeof se>[]) =>
  api.on("GET /api/agents/dev/events?", () => {
    resetSeq();
    return json({ events, hasMore: { before: false, after: false } });
  });
