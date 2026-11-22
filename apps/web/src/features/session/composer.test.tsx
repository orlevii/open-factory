import type { AgentSummary, QueueItem, SessionEvent } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactNode, useCallback, useReducer, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { agentDraftKey, readDraft } from "@/lib/drafts";
import { agentSummary } from "@/test/session-fixtures";
import { Composer, type ComposerHandle } from "./composer";
import { QueueItems } from "./queue-items";
import {
  initialSessionState,
  type SendingBlock,
  type SessionAction,
  sessionReducer,
} from "./session-state";

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
      : json({ item: { id: "q", kind: "message", from: "@alice", createdAt: "x" } }, 202);
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
      <Composer slug="dev" agent={agent} stopEpoch={epoch} />
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
  expect(interrupts()).toEqual([{ url: "/api/agents/dev/interrupt", body: {} }]);
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

test("while compacting the hint says the message arrives after it (no ⌥↵ promise)", () => {
  setup(working({ compacting: true }));
  expect(document.querySelector("[data-composer-hint]")).toHaveTextContent(
    /^Arrives after the compaction\.$/,
  );
  expect(document.querySelector("[data-composer-hint] kbd")).toBeNull();
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

test("⌥Enter posts urgent:true; Enter and ⌘Enter post urgent:false", async () => {
  const { box } = setup(working());
  const sends = () =>
    posted
      .filter((p) => p.url.endsWith("/messages"))
      .map((p) => {
        const { clientMessageId: _id, ...rest } = p.body as { clientMessageId?: string };
        return rest;
      });
  await userEvent.type(box, "a");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  await vi.waitFor(() => expect(sends()).toEqual([{ body: "a", urgent: true }]));
  await vi.waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "b{Enter}");
  await vi.waitFor(() => expect(sends()).toHaveLength(2));
  await vi.waitFor(() => expect(box).toHaveValue(""));
  await userEvent.type(box, "c");
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  await vi.waitFor(() =>
    expect(sends()).toEqual([
      { body: "a", urgent: true },
      { body: "b", urgent: false },
      { body: "c", urgent: false },
    ]),
  );
  expect(screen.queryByRole("checkbox", { name: "Urgent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send urgent" })).toBeNull();
});

test("⌥Enter during IME composition does not send", async () => {
  const { box } = setup(working());
  await userEvent.type(box, "日本");
  fireEvent.keyDown(box, { key: "Enter", altKey: true, isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", altKey: true, keyCode: 229 });
  await tick();
  // Only the commands list's prefetch (a GET); nothing sent.
  expect(posted.filter((p) => !p.url.endsWith("/commands"))).toEqual([]);
});

test("the hint shows only while a turn is open; the composer height is unchanged", () => {
  const { update } = setup(working());
  const hint = document.querySelector("[data-composer-hint]");
  expect(hint).toHaveTextContent(
    /^Arrives at the agent's next step\. (⌥|Alt)↵ to interrupt instead\.$/,
  );
  // The line's height is fixed whether or not it has text, so the composer never resizes: a fixed
  // height that clips (not a minimum the key caps could grow), and caps aligned inside the line box.
  expect(hint).toHaveClass("h-5", "truncate");
  expect(hint).not.toHaveClass("min-h-5");
  const caps = hint?.querySelector("kbd")?.parentElement;
  expect(caps).toHaveClass("align-top");
  expect(caps).not.toHaveClass("align-middle");
  update(agentSummary(), 2);
  const after = document.querySelector("[data-composer-hint]");
  expect(after).toBe(hint);
  expect(after).toBeEmptyDOMElement();
  expect(after).toHaveClass("h-5", "truncate");
});

test("on a coarse pointer the hint says to Stop first", () => {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    ...real(q),
    matches: q === "(pointer: coarse)",
  })) as typeof window.matchMedia;
  try {
    setup(working());
    expect(document.querySelector("[data-composer-hint]")).toHaveTextContent(
      "Arrives at the agent's next step. Stop first to interrupt.",
    );
  } finally {
    window.matchMedia = real;
  }
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

test("Stop's label hides below a narrow composer, keeping its name", () => {
  setup(working());
  const label = screen.getByText("Stop");
  // 20rem: a 390px phone's ~358px composer at 100% text keeps the label; 200% text drops it.
  expect(label).toHaveClass("@max-[20rem]:sr-only");
  expect(label.closest(".\\@container")).not.toBeNull();
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
        <QueueItems items={s.queue} sending={s.sending} agent={agent} self="alice" />
      </div>
      <Composer
        slug="dev"
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
    url.endsWith("/messages")
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
    .filter((p) => p.url.endsWith("/messages"))
    .map((p) => p.body as { body: string; urgent: boolean; clientMessageId: string });
const queueEl = () => screen.getByTestId("queue");
const accepted202 = (clientMessageId: string, over: Partial<QueueItem> = {}) =>
  json(
    {
      item: {
        id: "m1",
        kind: "message",
        from: "@alice",
        body: "hello",
        clientMessageId,
        createdAt: new Date().toISOString(),
        ...over,
      },
    },
    202,
  );
const echoIn = (seq: number, clientMessageId: string): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId: "t1",
  at: new Date().toISOString(),
  event: {
    type: "message_in",
    messages: [
      { id: "m1", from: "@alice", kind: "message", urgent: false, body: "hello", clientMessageId },
    ],
  },
});
const frame = (event: SessionEvent) =>
  act(() => act$?.({ type: "frame", message: { type: "session_event", agent: "dev", event } }));
function renderSession(agent = agentSummary()) {
  render(<Session agent={agent} />);
  return screen.getByRole("combobox", { name: "Message to Dev agent" });
}
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("the draft is in localStorage under a versioned key and survives a remount", async () => {
  const box = renderSession();
  await userEvent.type(box, "half a thought");
  box.blur();
  expect(readDraft(agentDraftKey("dev"))).toBe("half a thought");
  expect(localStorage.getItem("of-draft:v1:agent:dev")).not.toBeNull();
});

test("Enter clears the box and shows a muted Sending block: no time, no Cancel, no dashed edge", async () => {
  heldReply();
  const box = renderSession();
  await userEvent.type(box, "hello{Enter}");
  expect(box).toHaveValue("");
  const block = within(queueEl()).getByRole("group", { name: "Sending" });
  expect(block).toHaveTextContent("hello");
  expect(block).not.toHaveTextContent("Sending");
  expect(block).not.toHaveClass("border-dashed");
  expect(block.querySelector("time")).toBeNull();
  expect(within(block).queryByRole("button")).toBeNull();
  expect(block.querySelector("[data-message-body]")).toHaveClass("text-muted-foreground");
  const sent = messageSends()[0];
  expect(sent).toEqual({ body: "hello", urgent: false, clientMessageId: expect.any(String) });
  expect(sent?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  // The stored draft keeps the text until the server accepts it (after the 150ms write throttle).
  await sleep(200);
  expect(readDraft(agentDraftKey("dev"))).toBe("hello");
});

test("Sending… with a spinner appears only after 400ms", async () => {
  heldReply();
  const box = renderSession();
  await userEvent.type(box, "hello{Enter}");
  await sleep(250);
  expect(within(queueEl()).queryByText("Sending…")).toBeNull();
  await sleep(250);
  const label = within(queueEl()).getByText("Sending…");
  expect(label.closest("span")?.querySelector("svg.motion-safe\\:animate-spin")).not.toBeNull();
});

test("an ⌥Enter send says Sending · will interrupt the turn", async () => {
  heldReply();
  const box = renderSession(agentSummary({ status: "working", turnOpen: true }));
  await userEvent.type(box, "now");
  fireEvent.keyDown(box, { key: "Enter", altKey: true });
  await sleep(450);
  expect(within(queueEl()).getByText("Sending · will interrupt the turn")).toBeInTheDocument();
  expect(messageSends()[0]?.urgent).toBe(true);
});

test("the 202 replaces the block in place: same element, no Not delivered yet for 300ms", async () => {
  const held = heldReply();
  const box = renderSession();
  await userEvent.type(box, "hello{Enter}");
  const block = within(queueEl()).getByRole("group", { name: "Sending" });
  const id = messageSends()[0]?.clientMessageId ?? "";
  await held.resolve(accepted202(id));
  expect(within(queueEl()).queryByRole("group", { name: "Sending" })).toBeNull();
  const item = queueEl().querySelector("[data-message-block]");
  expect(item).toBe(block); // one commit, the same node: nothing re-enters
  expect(item).not.toHaveAttribute("data-live");
  expect(queueEl()).not.toHaveTextContent("Not delivered yet");
  await sleep(350);
  expect(queueEl()).toHaveTextContent("Not delivered yet");
  expect(readDraft(agentDraftKey("dev"))).toBe("");
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
  expect(readDraft(agentDraftKey("dev"))).toBe("");
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
        agent: "dev",
        items: [
          {
            id: "m1",
            kind: "message",
            from: "@alice",
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
  render(<Composer ref={ref} slug="dev" agent={working()} stopEpoch={1} />);
  expect(screen.getByRole("combobox")).not.toHaveFocus();
  act(() => {
    expect(ref.current?.putBackIfEmpty("cancelled text")).toBe(true);
  });
  expect(readDraft(agentDraftKey("dev"))).toBe("cancelled text");
  // Undo of an untouched box takes it out of the stored draft too.
  act(() => ref.current?.clearIfUnchanged("cancelled text"));
  expect(readDraft(agentDraftKey("dev"))).toBe("");
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

test("`@` inserts an agent's handle as plain text; nothing in the session says mention", async () => {
  qc.setQueryData(
    ["agents", "exclude"],
    [agentSummary({ slug: "dev" }), agentSummary({ slug: "qa", displayName: "QA agent" })],
  );
  const { box } = setup(agentSummary());
  const button = screen.getByRole("button", { name: "Insert an agent's handle" });
  await userEvent.type(box, "ask @q");
  expect(screen.getByRole("option", { name: /QA agent/ })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(box).toHaveValue("ask @qa ");
  // Nothing was sent; the opening menu loaded the users list, which nobody had cached (review I-2).
  // (The commands list is prefetched on mount, U3 §13.3 m11.)
  expect(posted.map((p) => p.url).filter((u) => !u.endsWith("/commands"))).toEqual(["/api/users"]);
  await userEvent.click(button);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  const composer = document.querySelector("#composer") as HTMLElement;
  const copy = [
    composer.textContent,
    ...[...document.querySelectorAll("[aria-label], [title]")].map(
      (e) => `${e.getAttribute("aria-label")} ${e.getAttribute("title")}`,
    ),
  ].join(" ");
  expect(copy.toLowerCase()).not.toContain("mention");
});

// ---- `/` commands (U3 §13.3) ----

const COMMANDS_RESPONSE = {
  commands: [
    { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
    {
      name: "code-review",
      description: "Review the diff",
      argumentHint: "[target]",
      builtin: true,
    },
  ],
  source: "session",
  at: "2026-11-21T10:00:00.000Z",
  stale: false,
};

test("the placeholder points at `/`", () => {
  const { box } = setup(agentSummary());
  expect(box).toHaveAttribute("placeholder", "Message Dev agent · / for commands");
});

test("a command dispatches to POST /commands with the chosen name and the args, never as text", async () => {
  qc.setQueryData(["agent-commands", "dev"], COMMANDS_RESPONSE);
  reply = (url) =>
    url.endsWith("/commands")
      ? json({ item: { id: "c1", kind: "command", from: "@alice", createdAt: "x" } }, 202)
      : json(COMMANDS_RESPONSE);
  const { box } = setup(agentSummary());
  await userEvent.type(box, "/code");
  expect(screen.getByRole("option", { name: /code-review/ })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await userEvent.type(box, "src/{Enter}");
  await tick();
  const sent = posted.filter((p) => p.url.includes("/api/agents/dev/"));
  expect(sent.map((p) => p.url)).toContain("/api/agents/dev/commands");
  const post = sent.find(
    (p) => p.url === "/api/agents/dev/commands" && "name" in (p.body as object),
  );
  expect(post?.body).toMatchObject({ name: "code-review", args: "src/" });
  expect(posted.some((p) => p.url.endsWith("/messages"))).toBe(false);
});

test("a 422 shows inline and sends no text", async () => {
  qc.setQueryData(["agent-commands", "dev"], COMMANDS_RESPONSE);
  reply = (url, init) =>
    url.endsWith("/commands") && init?.method === "POST"
      ? json(
          {
            error: {
              code: "unknown_command",
              message: "/context isn't a command this agent can run.",
            },
          },
          422,
        )
      : json(COMMANDS_RESPONSE);
  const { box } = setup(agentSummary());
  await userEvent.type(box, "/context {Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "/context isn't a command this agent can run.",
  );
  expect(posted.some((p) => p.url.endsWith("/messages"))).toBe(false);
});

test("`//x` sends `/x` as a message", async () => {
  const { box } = setup(agentSummary());
  await userEvent.type(box, "//deploy now");
  expect(
    screen.getByText("Sends as text; the agent may still run a skill by that name"),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await tick();
  const msg = posted.find((p) => p.url.endsWith("/messages"));
  expect(msg?.body).toMatchObject({ body: "/deploy now" });
});

test("`/foo` sends as text with the note", async () => {
  qc.setQueryData(["agent-commands", "dev"], COMMANDS_RESPONSE);
  const { box } = setup(agentSummary());
  await userEvent.type(box, "/foo");
  expect(screen.getByText("Not a command for this agent; sends as text")).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await tick();
  expect(posted.find((p) => p.url.endsWith("/messages"))?.body).toMatchObject({ body: "/foo" });
});

test("a command over 64 KB is refused inline before any POST", async () => {
  qc.setQueryData(["agent-commands", "dev"], COMMANDS_RESPONSE);
  const { box } = setup(agentSummary());
  await userEvent.type(box, "/context ");
  fireEvent.change(box, { target: { value: "x".repeat(70_000) } });
  await userEvent.type(box, "{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("The command is larger than 64 KB.");
  expect(posted.some((p) => p.url.endsWith("/commands") && "name" in (p.body as object))).toBe(
    false,
  );
});

test.each([
  [413, "too_large", "The command is larger than 64 KB."],
  [501, "commands_unsupported", "This agent can't run commands."],
  [409, "agent_archived", "This agent is archived."],
])("a %i shows inline and sends no text", async (status, code, message) => {
  qc.setQueryData(["agent-commands", "dev"], COMMANDS_RESPONSE);
  reply = (url, init) =>
    url.endsWith("/commands") && init?.method === "POST"
      ? json({ error: { code, message } }, status)
      : json(COMMANDS_RESPONSE);
  const { box } = setup(agentSummary());
  await userEvent.type(box, "/context {Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(posted.some((p) => p.url.endsWith("/messages"))).toBe(false);
});
