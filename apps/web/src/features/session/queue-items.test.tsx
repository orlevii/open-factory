import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderInRouter } from "@/test/render-in-router";
import { agentSummary } from "@/test/session-fixtures";
import { QueueItems } from "./queue-items";
import { ROW_GUTTER } from "./timeline-item";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(new Date(2026, 10, 19, 14, 0));
});
afterEach(() => vi.useRealTimers());

const local = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
const held = (o: Record<string, unknown>) =>
  ({ id: "m1", kind: "held", from: "dev", count: 3, createdAt: local(13, 59), ...o }) as never;
/** The line's whole text: the `@slug` is its own mono element inside it. */
const line = (text: string) =>
  screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === text);

test.each([
  [{ waitReason: "turn" }, "3 updates from @dev waiting for this turn to end"],
  [
    { waitReason: "window", dueAt: local(14, 32) },
    "3 updates from @dev waiting, delivered by 14:32",
  ],
  [{ waitReason: "starting" }, "3 updates from @dev waiting for this agent to start"],
  [{ waitReason: "errored" }, "3 updates from @dev held until a human restarts this agent"],
  [{ waitReason: "turn", count: 1 }, "1 update from @dev waiting for this turn to end"],
])("held line %o", (o, text) => {
  render(<QueueItems items={[held(o)]} agent={agentSummary()} />);
  expect(line(text)).toBeInTheDocument();
  expect(screen.getByText("@dev")).toHaveClass("font-mono");
});

test("rate-limited uses S5's reset phrase; peer events collapse into one line; nothing ticks", () => {
  render(
    <QueueItems
      items={[
        held({ waitReason: "rate_limited" }),
        held({ id: "p1", from: "@factory", count: 2, waitReason: "ride_along" }),
        held({ id: "p2", from: "@factory", count: 1, waitReason: "ride_along" }),
      ]}
      agent={agentSummary({
        status: "rate_limited",
        rateLimitedUntil: local(14, 30),
        rateLimitExact: true,
      })}
    />,
  );
  expect(line("3 updates from @dev held until 14:30")).toBeInTheDocument();
  expect(screen.getAllByText("3 peer changes waiting")).toHaveLength(1);
  const before = document.body.innerHTML;
  vi.advanceTimersByTime(5_000);
  expect(document.body.innerHTML).toBe(before);
});

test("rate-limited with an unreported window says retrying", () => {
  render(
    <QueueItems
      items={[held({ waitReason: "rate_limited" })]}
      agent={agentSummary({
        status: "rate_limited",
        rateLimitedUntil: local(14, 30),
        rateLimitExact: false,
      })}
    />,
  );
  expect(line("3 updates from @dev held retrying at 14:30")).toBeInTheDocument();
});

test("a group whose first row is a factory fact is from the report, never @@factory", () => {
  render(
    <QueueItems
      items={[held({ from: "@factory", about: "dev", waitReason: "turn" })]}
      agent={agentSummary()}
    />,
  );
  expect(line("3 updates from @dev waiting for this turn to end")).toBeInTheDocument();
});

test("a peer group held during an open turn is the peer line, never an update line", () => {
  render(
    <QueueItems
      items={[
        held({ waitReason: "turn" }),
        held({ id: "p1", from: "@factory", about: "b", count: 2, waitReason: "ride_along" }),
      ]}
      agent={agentSummary()}
    />,
  );
  expect(line("3 updates from @dev waiting for this turn to end")).toBeInTheDocument();
  expect(screen.getByText("2 peer changes waiting")).toBeInTheDocument();
  expect(screen.queryByText(/updates? from @b/)).toBeNull();
});

const msg = (o: Record<string, unknown>) =>
  ({ kind: "message", from: "@alice", body: "hello", createdAt: local(13, 59), ...o }) as never;

test("a held message during a Stop says so, preferring its waitReason over the agent's status", () => {
  render(
    <QueueItems
      items={[
        msg({ id: "m1", waitReason: "stopping" }),
        msg({ id: "n1", kind: "notice", waitReason: "stopping" }),
      ]}
      agent={agentSummary({ status: "rate_limited", rateLimitedUntil: local(14, 30) })}
    />,
  );
  // The reason once, on the first held block (U3 §7.6).
  expect(screen.getAllByText("Not delivered yet: stopping the turn")).toHaveLength(1);
  expect(screen.getAllByText("Not delivered yet")).toHaveLength(1);
});

test("the first held message says why; the rest only that they aren't delivered yet", () => {
  render(
    <QueueItems
      items={[
        held({ id: "h", waitReason: "turn" }),
        msg({ id: "a", body: "a" }),
        msg({ id: "b", body: "b" }),
      ]}
      agent={agentSummary({ status: "queued" })}
    />,
  );
  const blocks = document.querySelectorAll("[data-message-block]");
  expect(blocks[0]).toHaveTextContent("Not delivered yet: waiting for a free slot");
  expect(blocks[1]?.textContent).toContain("Not delivered yet");
  expect(blocks[1]?.textContent).not.toContain("Not delivered yet:");
});

test("queued bodies clamp at three lines", () => {
  render(
    <QueueItems items={[msg({ id: "a", body: "1\n\n2\n\n3\n\n4\n\n5" })]} agent={agentSummary()} />,
  );
  expect(document.querySelector("[data-message-body] .line-clamp-3")).not.toBeNull();
});

test("three queued messages all show; five show two and '+3 more queued' expands in place", async () => {
  vi.useRealTimers();
  const five = ["a", "b", "c", "d", "e"].map((id) => msg({ id, body: `body ${id}` }));
  const ui = (items: never[]) => (
    <QueueItems items={items} agent={agentSummary()} self="alice" onCancel={() => {}} />
  );
  const { rerender } = render(ui(five.slice(0, 3)));
  expect(document.querySelectorAll("[data-message-block]")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /more queued/ })).toBeNull();
  rerender(ui(five));
  expect(document.querySelectorAll("[data-message-block]")).toHaveLength(2);
  expect(screen.queryByText("body c")).toBeNull();
  const more = screen.getByRole("button", { name: "+3 more queued" });
  await userEvent.click(more);
  expect(document.querySelectorAll("[data-message-block]")).toHaveLength(5);
  expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /more queued/ })).toBeNull();
  // The disclosure went from under the focus: it lands on the first revealed message's Cancel.
  const third = screen.getByText("body c").closest("[data-message-block]") as HTMLElement;
  expect(within(third).getByRole("button", { name: "Cancel" })).toHaveFocus();
});

test("Cancel only on your own held messages: not others', task comments, scheduled or notices", async () => {
  const onCancel = vi.fn();
  vi.useRealTimers();
  // A router so the task comment's badge can resolve its link.
  renderInRouter(
    <QueueItems
      items={[
        msg({ id: "mine", body: "mine" }),
        msg({ id: "theirs", from: "@bob", body: "theirs" }),
        msg({ id: "task", taskKey: "T-1", body: "task" }),
        msg({ id: "sched", scheduleKey: "daily", body: "sched" }),
        msg({ id: "note", kind: "notice", body: "note" }),
      ]}
      agent={agentSummary()}
      self="alice"
      onCancel={onCancel}
    />,
  );
  const cancels = await screen.findAllByRole("button", { name: "Cancel" });
  expect(cancels).toHaveLength(1);
  const block = cancels[0]?.closest("[data-message-block]") as HTMLElement;
  expect(within(block).getByText("mine")).toBeInTheDocument();
  await userEvent.click(cancels[0] as HTMLElement);
  expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "mine" }));
});

test("a cancelled message shows the line in its place with Undo; back in the box when it moved there", async () => {
  vi.useRealTimers();
  const onUndo = vi.fn();
  const b = msg({ id: "b", body: "b" });
  const c = msg({ id: "c", body: "c" });
  const { rerender } = render(
    <QueueItems
      items={[msg({ id: "a", body: "a" }), c]}
      cancelled={new Map([["b", { item: b, index: 1 }]])}
      agent={agentSummary()}
      self="alice"
      onUndo={onUndo}
    />,
  );
  const line = screen.getByText("Message cancelled.");
  const blocks = document.querySelectorAll("[data-message-block]");
  expect(
    (blocks[0] as Node).compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    line.compareDocumentPosition(blocks[1] as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onUndo).toHaveBeenCalledWith("b", expect.objectContaining({ index: 1 }));
  rerender(
    <QueueItems
      items={[c]}
      cancelled={new Map([["b", { item: b, index: 0, inBox: true }]])}
      agent={agentSummary()}
      self="alice"
      onUndo={onUndo}
    />,
  );
  expect(screen.getByText("Message cancelled · back in the box.")).toBeInTheDocument();
});

test("a failed restore keeps the line, says why and drops Undo", () => {
  render(
    <QueueItems
      items={[]}
      cancelled={
        new Map([["b", { item: msg({ id: "b" }), index: 0, error: "This agent has ended." }]])
      }
      agent={agentSummary()}
      self="alice"
      onUndo={() => {}}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Message cancelled. Couldn't undo: This agent has ended.",
  );
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a failed cancel shows the message again with the reason under it", () => {
  render(
    <QueueItems
      items={[msg({ id: "b", body: "b" })]}
      cancelled={
        new Map([
          [
            "b",
            { item: msg({ id: "b" }), index: 0, error: "Already delivered.", rolledBack: true },
          ],
        ])
      }
      agent={agentSummary()}
      self="alice"
    />,
  );
  expect(screen.getByText("b")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't cancel: Already delivered.");
});

test("a cancel that lost the race (the frame already dropped the item) still says why", () => {
  render(
    <QueueItems
      items={[msg({ id: "a", body: "a" })]}
      cancelled={
        new Map([
          [
            "b",
            { item: msg({ id: "b" }), index: 1, error: "Already delivered.", rolledBack: true },
          ],
        ])
      }
      agent={agentSummary()}
      self="alice"
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Couldn't cancel: Already delivered.");
  const block = document.querySelector("[data-message-block]") as Node;
  expect(block.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("once restored, the line offers no second Undo", () => {
  render(
    <QueueItems
      items={[]}
      cancelled={new Map([["b", { item: msg({ id: "b" }), index: 0, restored: true }]])}
      agent={agentSummary()}
      self="alice"
      onUndo={() => {}}
    />,
  );
  expect(screen.getByText("Message cancelled.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a failed restore moves focus from Undo to the error line", async () => {
  vi.useRealTimers();
  const entry = { item: msg({ id: "b" }), index: 0 };
  const ui = (e: typeof entry & { error?: string }) => (
    <QueueItems
      items={[]}
      cancelled={new Map([["b", e]])}
      agent={agentSummary()}
      self="alice"
      onUndo={() => {}}
    />
  );
  const { rerender } = render(ui(entry));
  const undo = screen.getByRole("button", { name: "Undo" });
  undo.focus();
  rerender(ui({ ...entry, error: "This agent has ended." }));
  const errorLine = within(screen.getByRole("alert")).getByText(/Couldn't undo/).parentElement;
  await vi.waitFor(() => expect(errorLine).toHaveFocus());
});

test("queued and Sending cards span the column like a delivered card; a cancelled line keeps the rows' gutter", () => {
  render(
    <QueueItems
      items={[msg({ id: "a", body: "queued" })]}
      sending={[{ clientMessageId: "c1", body: "sending", urgent: false }]}
      cancelled={new Map([["b", { item: msg({ id: "b" }), index: 1 }]])}
      agent={agentSummary()}
      self="alice"
      onUndo={() => {}}
    />,
  );
  const wrap = (el: Element | null) => el?.closest(".pt-3");
  expect(wrap(screen.getByText("queued"))).not.toHaveClass(ROW_GUTTER);
  expect(wrap(screen.getByText("sending"))).not.toHaveClass(ROW_GUTTER);
  // The card's own padding matches a delivered card's, so its body wraps the same at the handoff.
  for (const t of ["queued", "sending"])
    expect(screen.getByText(t).closest("[data-message-block]")).toHaveClass("pr-9");
  expect(wrap(screen.getByText("Message cancelled."))).toHaveClass(ROW_GUTTER);
});

test("after a successful Undo focus goes to the restored message's Cancel, else the composer", async () => {
  vi.useRealTimers();
  const b = msg({ id: "b", body: "restored" });
  const composer = document.createElement("form");
  composer.id = "composer";
  composer.append(document.createElement("textarea"));
  document.body.append(composer);
  try {
    const ui = (items: never[], cancelled: Map<string, unknown>) => (
      <QueueItems
        items={items}
        cancelled={cancelled as never}
        agent={agentSummary()}
        self="alice"
        onCancel={() => {}}
        onUndo={() => {}}
      />
    );
    const { rerender } = render(ui([], new Map([["b", { item: b, index: 0 }]])));
    screen.getByRole("button", { name: "Undo" }).focus();
    rerender(ui([], new Map([["b", { item: b, index: 0, restored: true }]])));
    // The queue frame brings it back and the line goes.
    rerender(ui([b], new Map()));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await vi.waitFor(() => expect(cancel).toHaveFocus());
    // A line that goes with nothing to land on hands focus to the composer.
    rerender(ui([], new Map([["b", { item: b, index: 0 }]])));
    screen.getByRole("button", { name: "Undo" }).focus();
    rerender(ui([], new Map()));
    await vi.waitFor(() => expect(composer.querySelector("textarea")).toHaveFocus());
  } finally {
    composer.remove();
  }
});

// ---- Raw items are tail blocks of the timeline, not lines here (I1 §5) ----

test("a raw queue item and a raw sending block draw nothing in the queue area", () => {
  const raw = {
    id: "c1",
    kind: "raw",
    from: "@alice",
    body: "/context",
    createdAt: local(13, 59),
  } as never;
  const { container } = render(
    <QueueItems
      items={[raw]}
      sending={[{ clientMessageId: "x", body: "hi", urgent: false, raw: true }]}
      agent={agentSummary()}
      self="alice"
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("a queued item's sender is read by the kind it carries: an agent is a chip, a human a handle", async () => {
  vi.useRealTimers();
  const item = (id: string, from: string, fromKind: "agent" | "human") =>
    ({ id, kind: "message", from, fromKind, body: id, createdAt: local(13, 59) }) as never;
  renderInRouter(
    <QueueItems
      items={[item("a", "@gone-ab12", "agent"), item("h", "@orla", "human")]}
      agent={agentSummary()}
    />,
  );
  await waitFor(() => expect(document.querySelectorAll("[data-speaker-line]")).toHaveLength(2));
  const lines = document.querySelectorAll<HTMLElement>("[data-speaker-line]");
  expect(lines[0]?.querySelector("[data-agent-avatar]")).not.toBeNull();
  expect(lines[1]?.querySelector("[data-agent-avatar]")).toBeNull();
});
