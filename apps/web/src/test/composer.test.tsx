import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({
  onMessage: undefined as undefined | ((m: ServerMessage) => void),
}));
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
    return { close() {}, status: () => "open", send: () => true };
  },
}));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let posted: { url: string; body: unknown }[];
let postReply: (url: string) => Response | Promise<Response>;
let agentOver: Parameters<typeof detail>[0];
beforeEach(() => {
  localStorage.clear(); // drafts persist per agent
  posted = [];
  agentOver = {};
  postReply = (url) =>
    json(
      {
        item: {
          id: "q",
          kind: url.endsWith("compact") ? "compact" : "message",
          from: "@alice",
          fromKind: "human",
          createdAt: "x",
        },
      },
      202,
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return postReply(url);
      }
      if (url === "/api/agents/dev") return json(detail(agentOver));
      if (url.startsWith("/api/agents/dev/events")) return json(conversation());
      return json({}, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const box = () => screen.findByRole("combobox", { name: "Message to Dev agent" });

test("Enter sends, Shift+Enter adds a newline, the box clears on 202", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  await userEvent.type(input, "line one{Shift>}{Enter}{/Shift}line two");
  expect(input).toHaveValue("line one\nline two");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([
      {
        url: "/api/agents/dev/input",
        body: { text: "line one\nline two", clientMessageId: expect.any(String) },
      },
    ]),
  );
  await vi.waitFor(() => expect(input).toHaveValue(""));
});

test("Send is disabled for whitespace; there is no Urgent checkbox (⌥Enter is urgent, U3 §6.2)", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev/session", alice);
  const input = await box();
  await userEvent.type(input, "   ");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(screen.queryByRole("checkbox", { name: "Urgent" })).toBeNull();
});

test("a 70 KB message is refused before sending, with the draft kept", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  const big = "é".repeat(36_000);
  fireEvent.change(input, { target: { value: big } });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This message is 71 KB; the limit is 64 KB. Shorten it to send.",
  );
  expect(posted).toEqual([]);
  expect(input).toHaveValue(big);
});

test("the size error clears when the text is edited again", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  fireEvent.change(input, { target: { value: "é".repeat(36_000) } });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  await userEvent.type(input, "x");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("503 clears the box (the message is queued); a 400 keeps the text and shows the error inline", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  postReply = () =>
    json(
      {
        error: { code: "agent_start_failed", message: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents" },
      },
      503,
    );
  await userEvent.type(input, "hi{Enter}");
  await vi.waitFor(() => expect(input).toHaveValue(""));
  postReply = () =>
    json({ error: { code: "validation_error", message: "Message is larger than 64 KB" } }, 400);
  await userEvent.type(input, "big{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Message is larger than 64 KB");
  expect(input).toHaveValue("big");
});

test("slash text goes to /input as typed", async () => {
  renderApp("/agents/dev/session", alice);
  await userEvent.type(await box(), "/compact{Enter}");
  await vi.waitFor(() =>
    expect(posted[0]).toEqual({
      url: "/api/agents/dev/input",
      body: { text: "/compact", clientMessageId: expect.any(String) },
    }),
  );
});

/** Compact… lives in the header's ⋯ menu (U2 §8.4). */
const menu = () => screen.getByRole("button", { name: "Actions for Dev agent" });
async function openCompact() {
  await userEvent.click(menu());
  await userEvent.click(await screen.findByRole("menuitem", { name: "Compact…" }));
}

test("Compact popover: focus moves to the input; Enter submits with the focus text", async () => {
  renderApp("/agents/dev/session", alice);
  await box();
  await openCompact();
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  expect(focus).toHaveFocus();
  await userEvent.type(focus, "keep the API{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([{ url: "/api/agents/dev/compact", body: { focus: "keep the API" } }]),
  );
});

/** A reply the test resolves by hand, to hold a POST in flight. */
function deferred() {
  let resolve: (r: Response) => void = () => {};
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const accepted = () =>
  json(
    { item: { id: "q", kind: "message", from: "@alice", fromKind: "human", createdAt: "x" } },
    202,
  );
const status = (turnOpen: boolean) =>
  act(() =>
    ws.onMessage?.({
      type: "agent_status",
      agent: "dev",
      status: turnOpen ? "working" : "idle",
      turnOpen,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
const stop = () => screen.getByRole("button", { name: /^(Stop|Stopping…)$/ });

test("composer: IME composition Enter does not send (isComposing or keyCode 229)", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  await userEvent.type(input, "日本");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  await new Promise((r) => setTimeout(r, 20));
  expect(posted).toEqual([]);
  expect(input).toHaveValue("日本");
});

test("composer: on a coarse pointer Enter inserts a newline and only the button sends", async () => {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    ...real(q),
    matches: q === "(pointer: coarse)",
  })) as typeof window.matchMedia;
  try {
    renderApp("/agents/dev/session", alice);
    const input = await box();
    await userEvent.type(input, "a{Enter}b");
    expect(input).toHaveValue("a\nb");
    expect(posted).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
  } finally {
    window.matchMedia = real;
  }
});

test("composer: focus returns to the box after sending with the button", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  await userEvent.type(input, "hi");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(input).toHaveValue(""));
  expect(input).toHaveFocus();
});

test("composer: a network failure keeps the text and says the server is unreachable", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  postReply = () => {
    throw new TypeError("Failed to fetch");
  };
  await userEvent.type(input, "hi{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Can't reach the server. Check that it's running, then try again.",
  );
  expect(input).toHaveValue("hi");
});

test("composer: text typed while the send is in flight is kept", async () => {
  renderApp("/agents/dev/session", alice);
  const input = await box();
  const d = deferred();
  postReply = () => d.promise;
  await userEvent.type(input, "first{Enter}");
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await userEvent.type(input, " second");
  d.resolve(accepted());
  await vi.waitFor(() => expect(input).toHaveValue(" second"));
});

test("compact: Escape closes the popover and focus returns to the trigger", async () => {
  renderApp("/agents/dev/session", alice);
  await box();
  const trigger = menu();
  await openCompact();
  await screen.findByRole("textbox", { name: "Focus (optional)" });
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Focus (optional)" })).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(posted).toEqual([]);
});

test("compact: a second submit while one is in flight posts nothing; success closes it", async () => {
  renderApp("/agents/dev/session", alice);
  await box();
  await openCompact();
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  const d = deferred();
  postReply = () => d.promise;
  await userEvent.type(focus, "{Enter}");
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await userEvent.type(focus, "{Enter}");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual({ url: "/api/agents/dev/compact", body: {} });
  d.resolve(
    json(
      { item: { id: "q", kind: "compact", from: "@alice", fromKind: "human", createdAt: "x" } },
      202,
    ),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Focus (optional)" })).not.toBeInTheDocument(),
  );
});

test("compact: an error shows inside the popover and it stays open", async () => {
  renderApp("/agents/dev/session", alice);
  await box();
  await openCompact();
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  postReply = () =>
    json({ error: { code: "validation_error", message: "Focus is too long" } }, 400);
  await userEvent.type(focus, "x{Enter}");
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Focus is too long");
  expect(focus).toBeInTheDocument();
  expect(focus).toHaveValue("x");
});

test("Stop: not offered while no turn is open", async () => {
  renderApp("/agents/dev/session", alice);
  await box();
  expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  expect(posted).toEqual([]);
});

test("Stop: when the turn closes under a focused Stop, focus goes to the composer", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev/session", alice);
  const input = await box();
  stop().focus();
  status(false);
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  await vi.waitFor(() => expect(input).toHaveFocus());
});

test("Stop: posts one interrupt and re-enables when the turn closes and a new one opens", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev/session", alice);
  await box();
  postReply = () => json({}, 202);
  await userEvent.click(stop());
  await vi.waitFor(() => expect(posted).toEqual([{ url: "/api/agents/dev/interrupt", body: {} }]));
  expect(stop()).toHaveAttribute("aria-disabled", "true");
  // Both frames land in one commit (spec §9.6): Stop still sees the turn change.
  act(() => {
    for (const open of [false, true])
      ws.onMessage?.({
        type: "agent_status",
        agent: "dev",
        status: open ? "working" : "idle",
        turnOpen: open,
        restartPending: false,
        restartWaitingOn: 0,
      });
  });
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-disabled", "false"),
  );
});
