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
  sessionStorage.clear(); // drafts persist per agent
  posted = [];
  agentOver = {};
  postReply = (url) =>
    json(
      {
        item: {
          id: "q",
          kind: url.endsWith("compact") ? "compact" : "message",
          from: "@alice",
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

const box = () => screen.findByRole("textbox", { name: "Message to Dev agent" });

test("Enter sends, Shift+Enter adds a newline, the box clears on 202", async () => {
  renderApp("/agents/dev", alice);
  const input = await box();
  await userEvent.type(input, "line one{Shift>}{Enter}{/Shift}line two");
  expect(input).toHaveValue("line one\nline two");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([
      { url: "/api/agents/dev/messages", body: { body: "line one\nline two", urgent: false } },
    ]),
  );
  await vi.waitFor(() => expect(input).toHaveValue(""));
});

test("Send is disabled for whitespace; Urgent changes the label and hint, then resets", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  const input = await box();
  await userEvent.type(input, "   ");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
  expect(screen.getByRole("button", { name: "Send urgent" })).toBeInTheDocument();
  expect(screen.getByText("Interrupts the current turn, then runs next.")).toBeInTheDocument();
  await userEvent.type(input, "stop");
  await userEvent.click(screen.getByRole("button", { name: "Send urgent" }));
  await vi.waitFor(() => expect(posted[0]?.body).toEqual({ body: "stop", urgent: true }));
  await vi.waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Urgent" })).not.toBeChecked(),
  );
});

test("urgent while no turn is open says it sends normally", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
  expect(screen.getByText("No turn is running, so this sends normally.")).toBeInTheDocument();
});

test("503 clears the box (the message is queued); a 400 keeps the text and shows the error inline", async () => {
  renderApp("/agents/dev", alice);
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

test("slash text is sent as a plain message", async () => {
  renderApp("/agents/dev", alice);
  await userEvent.type(await box(), "/compact{Enter}");
  await vi.waitFor(() =>
    expect(posted[0]).toEqual({
      url: "/api/agents/dev/messages",
      body: { body: "/compact", urgent: false },
    }),
  );
});

test("Compact popover: focus moves to the input; Enter submits with the focus text", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Compact" }));
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  expect(focus).toHaveFocus();
  await userEvent.type(focus, "keep the API{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([{ url: "/api/agents/dev/compact", body: { focus: "keep the API" } }]),
  );
});

test("Interrupt posts only while a turn is open", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  await vi.waitFor(() => expect(posted).toEqual([{ url: "/api/agents/dev/interrupt", body: {} }]));
  expect(screen.getByRole("button", { name: "Interrupt" })).toHaveAttribute(
    "aria-disabled",
    "true",
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
  json({ item: { id: "q", kind: "message", from: "@alice", createdAt: "x" } }, 202);
const status = (turnOpen: boolean) =>
  act(() =>
    ws.onMessage?.({
      type: "agent_status",
      agent: "dev",
      status: turnOpen ? "working" : "idle",
      turnOpen,
    }),
  );
const interrupt = () => screen.getByRole("button", { name: "Interrupt" });

test("composer: IME composition Enter does not send (isComposing or keyCode 229)", async () => {
  renderApp("/agents/dev", alice);
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
    renderApp("/agents/dev", alice);
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
  renderApp("/agents/dev", alice);
  const input = await box();
  await userEvent.type(input, "hi");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(input).toHaveValue(""));
  expect(input).toHaveFocus();
});

test("composer: a network failure keeps the text and says the server is unreachable", async () => {
  renderApp("/agents/dev", alice);
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
  renderApp("/agents/dev", alice);
  const input = await box();
  const d = deferred();
  postReply = () => d.promise;
  await userEvent.type(input, "first{Enter}");
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await userEvent.type(input, " second");
  d.resolve(accepted());
  await vi.waitFor(() => expect(input).toHaveValue(" second"));
});

test("composer: the urgent hint sits under the composer row", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
  const hint = screen.getByText("No turn is running, so this sends normally.");
  const send = screen.getByRole("button", { name: "Send urgent" });
  expect(send.parentElement?.contains(hint)).toBe(false); // not squeezed into the button row
  expect(send.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("compact: Escape closes the popover and focus returns to the trigger", async () => {
  renderApp("/agents/dev", alice);
  await box();
  const trigger = screen.getByRole("button", { name: "Compact" });
  await userEvent.click(trigger);
  await screen.findByRole("textbox", { name: "Focus (optional)" });
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Focus (optional)" })).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(posted).toEqual([]);
});

test("compact: a second submit while one is in flight posts nothing; success closes it", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Compact" }));
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  const d = deferred();
  postReply = () => d.promise;
  await userEvent.type(focus, "{Enter}");
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await userEvent.type(focus, "{Enter}");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual({ url: "/api/agents/dev/compact", body: {} });
  d.resolve(json({ item: { id: "q", kind: "compact", from: "@alice", createdAt: "x" } }, 202));
  await vi.waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Focus (optional)" })).not.toBeInTheDocument(),
  );
});

test("compact: an error shows inside the popover and it stays open", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Compact" }));
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  postReply = () =>
    json({ error: { code: "validation_error", message: "Focus is too long" } }, 400);
  await userEvent.type(focus, "x{Enter}");
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Focus is too long");
  expect(focus).toBeInTheDocument();
  expect(focus).toHaveValue("x");
});

test("interrupt: does nothing while no turn is open", async () => {
  renderApp("/agents/dev", alice);
  await box();
  expect(interrupt()).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(interrupt());
  await new Promise((r) => setTimeout(r, 20));
  expect(posted).toEqual([]);
});

test("interrupt: re-enables when the turn closes and a new one opens", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(interrupt());
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  expect(interrupt()).toHaveAttribute("aria-disabled", "true");
  status(false);
  expect(interrupt()).toHaveAttribute("aria-disabled", "true");
  status(true);
  await vi.waitFor(() => expect(interrupt()).toHaveAttribute("aria-disabled", "false"));
});

test("interrupt: a 409 (the turn already ended) is ignored", async () => {
  agentOver = { status: "working", turnOpen: true };
  postReply = () => json({ error: { code: "no_open_turn", message: "No turn is open" } }, 409);
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(interrupt());
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(interrupt()).toHaveAttribute("aria-disabled", "true");
});

test("interrupt: any other failure shows an inline error and allows a retry", async () => {
  agentOver = { status: "working", turnOpen: true };
  postReply = () => json({ error: { code: "internal", message: "Boom" } }, 500);
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(interrupt());
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't interrupt: Boom");
  expect(interrupt()).toHaveAttribute("aria-disabled", "false");
  postReply = () => json({}, 202);
  await userEvent.click(interrupt());
  await vi.waitFor(() => expect(posted).toHaveLength(2));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

test("interrupt: after a click the tooltip says it was sent", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(interrupt());
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  await userEvent.unhover(interrupt()); // Radix keeps a clicked trigger's tooltip shut until re-entry
  await userEvent.hover(interrupt());
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Interrupt sent");
});
