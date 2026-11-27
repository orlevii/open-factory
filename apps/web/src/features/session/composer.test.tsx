import type { AgentSummary, QueueItem, SessionEvent } from "@open-factory/shared";
import { mentionOf } from "@open-factory/shared/mentions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactNode, useCallback, useReducer, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { readDraft, sessionDraftKey } from "@/lib/drafts";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { refFor } from "@/test/refs";
import { agentSummary, envelope } from "@/test/session-fixtures";
import { Composer, type ComposerHandle } from "./composer";
import { QueueItems } from "./queue-items";
import {
  initialSessionState,
  type SendingBlock,
  type SessionAction,
  sessionReducer,
} from "./session-state";

/** The raw session's hint links to the chat; a plain anchor stands in for the router's Link here. */
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: { ref: string };
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to.replace("$ref", params.ref)} className={className}>
      {children}
    </a>
  ),
}));

/** The session's composer reads the cached agents and users lists for `@` (U3 §13.4). */
let qc: QueryClient;
const render = (ui: ReactNode) =>
  rtlRender(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let posted: { url: string; body: unknown }[];
let reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  qc = new QueryClient();
  localStorage.clear();
  posted = [];
  reply = (url) =>
    url.endsWith("/interrupt")
      ? json({}, 202)
      : json(
          {
            results: [
              {
                to: "@dev",
                status: "queued",
                item: {
                  id: "q",
                  kind: "message",
                  from: mentionOf(refFor("alice")),
                  fromKind: "human",
                  createdAt: "x",
                },
              },
            ],
          },
          202,
        );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return reply(url, init);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const working = (over: Partial<AgentSummary> = {}) =>
  agentSummary({ status: "working", turnOpen: true, ...over });

/** The composer as the session renders it, with its agent and turn epoch changeable from the test. */
function setup(initial: AgentSummary, extra?: ReactNode) {
  const ui = (agent: AgentSummary, epoch: number) => (
    <>
      {extra}
      <Composer agentRef={refFor("dev")} agent={agent} stopEpoch={epoch} />
    </>
  );
  const r = render(ui(initial, 1));
  return {
    box: screen.getByRole("combobox", { name: "Message to Dev agent" }),
    update: (a: AgentSummary, epoch: number) => r.rerender(ui(a, epoch)),
  };
}

/** A non-modal popover standing in for a peek: open, with focus left in the composer. */
function Peek() {
  const [open, setOpen] = useState(true);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor />
      <PopoverContent onOpenAutoFocus={(e) => e.preventDefault()}>Peek body</PopoverContent>
    </Popover>
  );
}
const interrupts = () => posted.filter((p) => p.url.endsWith("/interrupt"));
const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));

test("Esc in the composer stops an open turn once; does nothing with no turn", async () => {
  const { box, update } = setup(working());
  box.focus();
  fireEvent.keyDown(box, { key: "Escape" });
  fireEvent.keyDown(box, { key: "Escape" }); // Stop is pending: no second interrupt
  await tick();
  expect(interrupts()).toEqual([{ url: `/api/agents/${refFor("dev")}/interrupt`, body: {} }]);
  update(agentSummary(), 2);
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(interrupts()).toHaveLength(1);
});

test("Esc that stops is handled; Esc that doesn't is left to others", async () => {
  const { box, update } = setup(working());
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  try {
    fireEvent.keyDown(box, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    update(agentSummary(), 2);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener("keydown", outer);
  }
});

test("Esc during IME composition does nothing", async () => {
  const { box } = setup(working());
  fireEvent.keyDown(box, { key: "Escape", isComposing: true });
  fireEvent.keyDown(box, { key: "Escape", keyCode: 229 });
  await tick();
  expect(interrupts()).toEqual([]);
});

test("Esc with an open peek lets the peek close and doesn't stop", async () => {
  const { box } = setup(working(), <Peek />);
  box.focus();
  expect(screen.getByText("Peek body")).toBeInTheDocument();
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(screen.queryByText("Peek body")).toBeNull();
  expect(interrupts()).toEqual([]);
  fireEvent.keyDown(box, { key: "Escape" }); // nothing open now: this one stops
  await tick();
  expect(interrupts()).toHaveLength(1);
});

test("while compacting Stop is disabled and reads Compacting…", async () => {
  const { box } = setup(working({ compacting: true }));
  const stop = screen.getByRole("button", { name: "Compacting…" });
  expect(stop).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(stop);
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(interrupts()).toEqual([]);
});

test("a 409 compacting on Stop resets the button, which then reads Compacting…", async () => {
  reply = (url) =>
    url.endsWith("/interrupt")
      ? json({ error: { code: "compacting", message: "Compacting" } }, 409)
      : json({}, 202);
  const { update } = setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await tick();
  update(working({ compacting: true }), 1);
  expect(screen.getByRole("button", { name: "Compacting…" })).toBeInTheDocument();
});

test("Stop resets from Stopping… when stopEpoch changes within the same turn (unconfirmed stop)", async () => {
  const { update } = setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(screen.getByRole("button", { name: "Stopping…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  update(working(), 2); // the turn is still open: only the stop epoch moved
  const stop = screen.getByRole("button", { name: "Stop" });
  expect(stop).toHaveAttribute("aria-disabled", "false");
  await userEvent.click(stop);
  expect(interrupts()).toHaveLength(2);
});

test("⌥Enter during IME composition does not send", async () => {
  const { box } = setup(working());
  await userEvent.type(box, "日本");
  fireEvent.keyDown(box, { key: "Enter", altKey: true, isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", altKey: true, keyCode: 229 });
  await tick();
  // Only the reads (the commands prefetch, the lists); nothing sent.
  expect(posted.filter((p) => !/\/commands$|^\/api\/(agents\?|principals)/.test(p.url))).toEqual(
    [],
  );
});

test("Stop is outline, left of Send; shows a spinner and Stopping… until turnEpoch changes", async () => {
  const { update } = setup(working());
  const stop = screen.getByRole("button", { name: "Stop" });
  const send = screen.getByRole("button", { name: "Send" });
  expect(stop).toHaveAttribute("data-variant", "outline");
  expect(stop.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(stop.querySelector(".lucide-circle-stop")).not.toBeNull();
  await userEvent.click(stop);
  const stopping = screen.getByRole("button", { name: "Stopping…" });
  expect(stopping).toBe(stop);
  expect(stopping).toHaveAttribute("aria-disabled", "true");
  expect(stopping.querySelector(".lucide-circle-stop")).toBeNull();
  expect(stopping.querySelector("svg.motion-safe\\:animate-spin")).not.toBeNull();
  await userEvent.click(stopping);
  expect(interrupts()).toHaveLength(1);
  // The turn closed and a new one opened in one commit: the epoch still resets Stop.
  update(working(), 3);
  expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-disabled", "false");
});

test("no Stop while no turn is open", () => {
  setup(agentSummary());
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
});

test("a 409 from Stop is ignored; other failures go to the composer's error line", async () => {
  reply = () => json({ error: { code: "no_open_turn", message: "No turn is open" } }, 409);
  setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await tick();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeInTheDocument();
});

test("a failed Stop says why and allows a retry", async () => {
  reply = () => json({ error: { code: "internal", message: "Boom" } }, 500);
  setup(working());
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't stop: Boom");
  expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-disabled", "false");
});

test("focus moves to the textarea when Stop unmounts while focused", async () => {
  const { box, update } = setup(working());
  screen.getByRole("button", { name: "Stop" }).focus();
  update(agentSummary(), 2);
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  await vi.waitFor(() => expect(box).toHaveFocus());
});

test("a turn closing doesn't move focus that wasn't on Stop", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    const { update } = setup(working());
    outside.focus();
    update(agentSummary(), 2);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(outside).toHaveFocus();
  } finally {
    outside.remove();
  }
});

// U3 §13.2 (Q22, Q29): durable drafts and optimistic sends, with the session's reducer and queue.
let act$: ((a: SessionAction) => void) | undefined;
function Session({ agent }: { agent: AgentSummary }) {
  const [s, dispatch] = useReducer(sessionReducer, undefined, () =>
    sessionReducer(initialSessionState, {
      type: "loaded",
      page: { events: [], hasMore: { before: false, after: false } },
      detail: { agent, queue: [], lastSeq: 0 },
      mode: "latest",
    }),
  );
  act$ = dispatch;
  const onSending = useCallback((block: SendingBlock) => dispatch({ type: "sending", block }), []);
  const onSendFailed = useCallback(
    (clientMessageId: string, unconfirmed?: boolean) =>
      dispatch({ type: "send_failed", clientMessageId, unconfirmed }),
    [],
  );
  const onQueued = useCallback(
    (item: QueueItem) => dispatch({ type: "queued", item, live: true }),
    [],
  );
  return (
    <>
      <div data-testid="queue">
        <QueueItems
          items={s.queue}
          sending={s.sending}
          agent={agent}
          selfMention={mentionOf(refFor("alice"))}
        />
      </div>
      <Composer
        agentRef={refFor("dev")}
        agent={agent}
        stopEpoch={1}
        onSending={onSending}
        onSendFailed={onSendFailed}
        onQueued={onQueued}
        landed={s.landed}
      />
    </>
  );
}

/** A reply held until the test resolves it; it rejects like fetch when the request is aborted. */
function heldReply() {
  let resolve: (r: Response) => void = () => {};
  reply = (url, init) =>
    url.endsWith("/input")
      ? new Promise<Response>((res, rej) => {
          resolve = res;
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("The operation was aborted.", "AbortError")),
          );
        })
      : json({}, 202);
  return { resolve: (r: Response) => act(async () => resolve(r)) };
}
const messageSends = () =>
  posted
    .filter((p) => p.url.endsWith("/input"))
    .map((p) => ({
      body: (p.body as { text: string }).text,
      ...(p.body as { clientMessageId: string }),
    }));
const queueEl = () => screen.getByTestId("queue");
const _accepted202 = (clientMessageId: string, over: Partial<QueueItem> = {}) =>
  json(
    {
      results: [
        {
          to: "@dev",
          status: "queued",
          item: {
            id: "m1",
            kind: "message",
            from: mentionOf(refFor("alice")),
            fromKind: "human",
            body: "hello",
            clientMessageId,
            createdAt: new Date().toISOString(),
            ...over,
          },
        },
      ],
    },
    202,
  );
const echoIn = (seq: number, clientMessageId: string): SessionEvent => ({
  seq,
  agentRef: refFor("dev"),
  turnId: "t1",
  at: new Date().toISOString(),
  event: {
    type: "message_in",
    messages: [
      envelope({
        id: "m1",
        from: mentionOf(refFor("alice")),
        fromKind: "human",
        kind: "message",
        urgent: false,
        body: "hello",
        clientMessageId,
      }),
    ],
  },
});
const frame = (event: SessionEvent) =>
  act(() =>
    act$?.({ type: "frame", message: { type: "session_event", agent: refFor("dev"), event } }),
  );
function renderSession(agent = agentSummary()) {
  render(<Session agent={agent} />);
  return screen.getByRole("combobox", { name: "Message to Dev agent" });
}
const _sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("the draft is in localStorage under a versioned key and survives a remount", async () => {
  const box = renderSession();
  await userEvent.type(box, "half a thought");
  box.blur();
  expect(readDraft(sessionDraftKey(refFor("dev")))).toBe("half a thought");
  expect(localStorage.getItem(`of-draft:v1:session:${refFor("dev")}`)).not.toBeNull();
  cleanup();
  expect(renderSession()).toHaveValue("half a thought");
});

test("a message_in echoing the id removes the block in one step", async () => {
  heldReply();
  const box = renderSession();
  await userEvent.type(box, "hello{Enter}");
  const id = messageSends()[0]?.clientMessageId ?? "";
  frame(echoIn(5, id));
  expect(within(queueEl()).queryByRole("group", { name: "Sending" })).toBeNull();
  expect(queueEl()).toBeEmptyDOMElement();
});

test("a failure removes the block and puts the text back, after anything typed since", async () => {
  const held = heldReply();
  const box = renderSession();
  await userEvent.type(box, "hello{Enter}");
  await userEvent.type(box, "more");
  await held.resolve(json({ error: { code: "internal", message: "Boom" } }, 500));
  expect(within(queueEl()).queryByRole("group", { name: "Sending" })).toBeNull();
  expect(box).toHaveValue("more\nhello");
  expect(screen.getByRole("alert")).toHaveTextContent("Boom");
});

test("after 15s the send aborts; Enter on the unchanged text reuses the same clientMessageId", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const box = renderSession();
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter" });
  const first = messageSends()[0]?.clientMessageId;
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(within(queueEl()).queryByRole("group", { name: "Sending" })).toBeNull();
  expect(box).toHaveValue("hello");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't confirm the send. Retry sends it once.",
  );
  fireEvent.keyDown(box, { key: "Enter" });
  expect(messageSends()).toHaveLength(2);
  expect(messageSends()[1]?.clientMessageId).toBe(first);
});

test("Retry after the abort reuses the id too; changed text gets a new one", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const box = renderSession();
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(messageSends()[1]?.clientMessageId).toBe(messageSends()[0]?.clientMessageId);
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  fireEvent.change(box, { target: { value: "hello!" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(messageSends()[2]?.clientMessageId).not.toBe(messageSends()[0]?.clientMessageId);
});

test("a late message_in for an aborted send clears the unchanged box and the error", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const box = renderSession();
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter" });
  const id = messageSends()[0]?.clientMessageId ?? "";
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  frame(echoIn(5, id));
  expect(box).toHaveValue("");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(readDraft(sessionDraftKey(refFor("dev")))).toBe("");
});

test("an aborted send whose item the queue already showed counts as sent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const box = renderSession();
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter" });
  const id = messageSends()[0]?.clientMessageId ?? "";
  act(() =>
    act$?.({
      type: "frame",
      message: {
        type: "queue",
        agent: refFor("dev"),
        items: [
          {
            id: "m1",
            kind: "message",
            from: mentionOf(refFor("alice")),
            fromKind: "human",
            body: "hello",
            clientMessageId: id,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(box).toHaveValue("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a Cancel put-back is saved as the draft at once, even with the box unfocused (reload keeps it)", () => {
  const ref = createRef<ComposerHandle>();
  render(<Composer ref={ref} agentRef={refFor("dev")} agent={working()} stopEpoch={1} />);
  expect(screen.getByRole("combobox")).not.toHaveFocus();
  act(() => {
    expect(ref.current?.putBackIfEmpty("cancelled text")).toBe(true);
  });
  expect(readDraft(sessionDraftKey(refFor("dev")))).toBe("cancelled text");
  // Undo of an untouched box takes it out of the stored draft too.
  act(() => ref.current?.clearIfUnchanged("cancelled text"));
  expect(readDraft(sessionDraftKey(refFor("dev")))).toBe("");
});

test("after an abort, text typed meanwhile makes Enter send under a new id, and there is no Retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const box = renderSession();
  fireEvent.change(box, { target: { value: "first part" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.change(box, { target: { value: "typed meanwhile" } });
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  expect(box).toHaveValue("typed meanwhile\nfirst part");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't confirm the send. It may still arrive; check before sending again.",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("Retry");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(messageSends()[1]?.clientMessageId).not.toBe(messageSends()[0]?.clientMessageId);
});

test("a remount after an abort resends the unchanged text under the same id", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldReply();
  const first = render(<Session agent={agentSummary()} />);
  const box = screen.getByRole("combobox", { name: "Message to Dev agent" });
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  first.unmount();
  const again = renderSession();
  expect(again).toHaveValue("hello");
  fireEvent.keyDown(again, { key: "Enter" });
  expect(messageSends()).toHaveLength(2);
  expect(messageSends()[1]?.clientMessageId).toBe(messageSends()[0]?.clientMessageId);
});

// ---- `@` (U3 §13.4, Q23) ----

// ---- the session composer is raw (I1 §5.4) ----

const COMMANDS_RESPONSE = {
  commands: [
    { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
    {
      name: "code-review",
      description: "Review the diff",
      argumentHint: "[target]",
      builtin: true,
    },
    {
      name: "clear",
      description: "Start over",
      argumentHint: "",
      builtin: true,
      denied: "/clear isn't available: each agent keeps one session.",
    },
  ],
  source: "session",
  at: "2026-11-21T10:00:00.000Z",
  stale: false,
};
const inputs = () =>
  posted
    .filter((p) => p.url === `/api/agents/${refFor("dev")}/input`)
    .map((p) => p.body as { text: string; clientMessageId: string });
const hintLine = () => document.querySelector("[data-composer-hint]") as HTMLElement;
const raw = (agent = agentSummary()) => setup(agent);

test("placeholder, toolbar and hint of the raw session", () => {
  const { box } = raw();
  expect(box).toHaveAttribute("placeholder", "Raw input to Claude · / for commands");
  expect(screen.getByRole("button", { name: "Run a command" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Insert an agent's handle" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
  expect(hintLine()).toHaveTextContent("Goes to Claude as typed · Message Dev agent in Chat");
  // Until the chat has its own page the link goes to the agent (PR 3 points it at /chat).
  expect(
    within(hintLine()).getByRole("link", { name: "Message Dev agent in Chat" }),
  ).toHaveAttribute("href", `/agents/${refFor("dev")}/chat`);
});

test("with a turn open the hint says raw input runs after it", () => {
  const { update } = raw(working());
  expect(hintLine()).toHaveTextContent(/^Runs after the current turn\.$/);
  expect(hintLine().querySelector("kbd")).toBeNull();
  update(agentSummary(), 2);
  expect(hintLine()).toHaveTextContent("Goes to Claude as typed");
});

test("a dropped file says files go through the chat", () => {
  const { box } = raw();
  fireEvent.drop(box.closest("[data-composer-frame]") as HTMLElement, {
    dataTransfer: { files: [new File(["x"], "a.txt")], items: [], types: ["Files"] },
  });
  expect(hintLine()).toHaveTextContent("Files can be sent from the chat");
});

test("Enter and ⌥Enter both POST /input as typed, with a clientMessageId and no urgency", async () => {
  const { box } = raw(working());
  await userEvent.type(box, "  /context now");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  expect(inputs()[0]).toMatchObject({ text: "  /context now" });
  expect(inputs()[0]?.clientMessageId).toEqual(expect.any(String));
  expect(inputs()[0]).not.toHaveProperty("urgent");
  await vi.waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "hello{Enter}");
  await vi.waitFor(() => expect(inputs()).toHaveLength(2));
  expect(
    posted.some(
      (p) =>
        p.url.endsWith("/messages") ||
        (p.url.endsWith("/commands") && p.body && "name" in (p.body as object)),
    ),
  ).toBe(false);
});

test("a command and its arguments are one text; nothing is dispatched as a command", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "/code");
  expect(screen.getByRole("option", { name: /code-review/ })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}"); // accepting inserts `/code-review `
  expect(box).toHaveValue("/code-review ");
  await userEvent.type(box, "src/{Enter}");
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  expect(inputs()[0]?.text).toBe("/code-review src/");
});

test("`/clear ` shows its reason in the note slot and holds Send; `/news-digest` shows nothing", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "/news-digest");
  expect(hintLine()).toHaveTextContent("Goes to Claude as typed"); // the rest hint, no note
  await userEvent.type(box, " today");
  expect(hintLine()).not.toHaveTextContent("isn't available");
  await userEvent.clear(box);
  await userEvent.type(box, "/clear ");
  expect(hintLine()).toHaveTextContent("/clear isn't available: each agent keeps one session.");
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(send);
  fireEvent.keyDown(box, { key: "Enter" });
  await tick();
  expect(inputs()).toEqual([]);
});

test("a denied row shows only on an exact match, disabled, with its reason", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "/cle");
  expect(screen.queryByRole("option", { name: /clear/ })).toBeNull();
  await userEvent.type(box, "ar");
  const row = screen.getByRole("option", { name: /clear/ });
  expect(row).toHaveAttribute("aria-disabled", "true");
  expect(row).toHaveTextContent("/clear isn't available: each agent keeps one session.");
});

test("Enter on `/context` while the commands list is pending POSTs /input", async () => {
  reply = (url) => (url.endsWith("/commands") ? new Promise<Response>(() => {}) : json({}, 202));
  const { box } = raw();
  await userEvent.type(box, "/context{Enter}");
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  expect(inputs()[0]?.text).toBe("/context");
});

test("a pasted `/context` and Enter POSTs /input", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  box.focus();
  await userEvent.paste("/context");
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  expect(inputs()[0]?.text).toBe("/context");
});

test("an empty list and `/context` POSTs /input", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], { ...COMMANDS_RESPONSE, commands: [] });
  const { box } = raw();
  await userEvent.type(box, "/context{Enter}");
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  expect(inputs()[0]?.text).toBe("/context");
});

test("a typed `/clear` and Enter is refused in the slot, never posted", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "/clear{Enter}");
  await tick();
  expect(inputs()).toEqual([]);
  expect(hintLine()).toHaveTextContent("/clear isn't available");
});

test("Esc closes the menu first; with none open it stops the turn", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw(working());
  await userEvent.type(box, "/co");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(interrupts()).toEqual([]);
  fireEvent.keyDown(box, { key: "Escape" });
  await tick();
  expect(interrupts()).toHaveLength(1);
});

test("a refused input shows inline and the text comes back", async () => {
  reply = (url) =>
    url.endsWith("/input")
      ? json({ error: { code: "command_denied", message: "/clear isn't available." } }, 422)
      : json(COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "hello{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("/clear isn't available.");
  expect(box).toHaveValue("hello");
});

test("the note slot carries a refusal's full text in its title, since the line can be cut", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  expect(hintLine()).not.toHaveAttribute("title");
  await userEvent.type(box, "/clear ");
  expect(hintLine()).toHaveAttribute(
    "title",
    "/clear isn't available: each agent keeps one session.",
  );
});

test("a known command over several lines is refused in the slot and held", async () => {
  qc.setQueryData(["agent-commands", refFor("dev")], COMMANDS_RESPONSE);
  const { box } = raw();
  await userEvent.type(box, "/context{Shift>}{Enter}{/Shift}more");
  expect(hintLine()).toHaveTextContent("A command must be one line.");
  fireEvent.keyDown(box, { key: "Enter" });
  await tick();
  expect(inputs()).toEqual([]);
  await userEvent.clear(box);
  await userEvent.type(box, "/Users/or/x{Shift>}{Enter}{/Shift}y");
  expect(hintLine()).not.toHaveTextContent("one line");
});

test("on a phone the session composer reserves the note line", () => {
  const real = window.matchMedia;
  try {
    fakeMatchMedia.install(true);
    raw();
    expect(document.querySelector("[data-composer-note-line]")).not.toBeNull();
    cleanup();
    fakeMatchMedia.install(false);
    raw();
    expect(document.querySelector("[data-composer-note-line]")).toBeNull();
  } finally {
    window.matchMedia = real;
  }
});
