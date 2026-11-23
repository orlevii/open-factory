import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { rawTailRows } from "./raw-tail";
import { buildRows } from "./rows";
import { SLOW_SEND_MS, YOUNG_ITEM_MS } from "./send-phase";
import { Timeline } from "./timeline";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(new Date(2026, 10, 19, 14, 0));
});
afterEach(() => vi.useRealTimers());

const CID = "5b1f1c1e-0000-4c1a-9a43-1d1f6f8f2a10";
const queueItem = {
  id: "q1",
  kind: "raw",
  from: "@alice",
  body: "/context",
  clientMessageId: CID,
  createdAt: new Date(2026, 10, 19, 14, 0).toISOString(),
} as never;
const block = { clientMessageId: CID, body: "/context", urgent: false, raw: true } as const;
const operatorInput = [
  {
    seq: 5,
    agentSlug: "dev",
    turnId: null,
    at: "2026-11-19T14:00:01.000Z",
    event: {
      type: "operator_input",
      text: "/context",
      by: "@alice",
      clientMessageId: CID,
      entryId: "e1",
    },
  },
] as never;

const view = (o: { rows?: never; pending?: ReturnType<typeof rawTailRows> }) => (
  <Timeline
    slug="dev"
    rows={o.rows ? buildRows(o.rows).rows : []}
    pendingRows={o.pending}
    failedIds={new Set()}
    interruptedEnds={new Set()}
    hasMoreBefore={false}
    onLoadEarlier={async () => false}
    earlierError={false}
    footer={null}
  />
);

test("one element from Sending to the queued item to the operator_input row", () => {
  const none = new Map();
  const mount = vi.fn();
  const seen = new Set<Element>();
  const observe = () => {
    for (const el of document.querySelectorAll("[data-message-block]")) {
      if (!seen.has(el)) mount();
      seen.add(el);
    }
  };
  const { rerender } = render(
    view({ pending: rawTailRows([], [block], none, "alice", undefined) }),
  );
  observe();
  expect(screen.getByRole("group", { name: "Sending" })).toBeInTheDocument();
  rerender(view({ pending: rawTailRows([queueItem], [], none, "alice", () => {}) }));
  observe();
  expect(document.querySelector("[data-message-block]")).toHaveClass("border-dashed");
  rerender(view({ rows: operatorInput }));
  observe();
  expect(document.querySelector("[data-message-block]")).not.toHaveClass("border-dashed");
  expect(screen.getByText("@alice")).toBeInTheDocument();
  expect(mount).toHaveBeenCalledTimes(1);
});

test("the block says raw, keeps the text as typed and is mono for a command", () => {
  render(view({ pending: rawTailRows([queueItem], [], new Map(), "alice", undefined) }));
  expect(screen.getByText("· raw")).toBeInTheDocument();
  const body = screen.getByText("/context");
  expect(body).toHaveClass("font-mono", "whitespace-pre-wrap");
});

test("Sending… and Runs after… stay hidden on a fast path", () => {
  const none = new Map();
  const { rerender } = render(
    view({ pending: rawTailRows([], [block], none, "alice", undefined) }),
  );
  act(() => vi.advanceTimersByTime(SLOW_SEND_MS - 50));
  expect(screen.queryByText("Sending…")).toBeNull();
  rerender(view({ pending: rawTailRows([queueItem], [], none, "alice", undefined) }));
  expect(screen.queryByText("Runs after the current turn")).toBeNull();
  act(() => vi.advanceTimersByTime(YOUNG_ITEM_MS + 50));
  expect(screen.getByText("Runs after the current turn")).toBeInTheDocument();
});

test("a slow send says Sending…", () => {
  render(view({ pending: rawTailRows([], [block], new Map(), "alice", undefined) }));
  act(() => vi.advanceTimersByTime(SLOW_SEND_MS + 10));
  expect(screen.getByText("Sending…")).toBeInTheDocument();
});

test("Cancel is on your own queued raw block only", () => {
  const onCancel = vi.fn();
  const theirs = {
    ...(queueItem as object),
    id: "q2",
    from: "@bob",
    clientMessageId: "other",
  } as never;
  render(view({ pending: rawTailRows([queueItem, theirs], [], new Map(), "alice", onCancel) }));
  const buttons = screen.getAllByRole("button", { name: "Cancel" });
  expect(buttons).toHaveLength(1);
  act(() => buttons[0]?.click());
  expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }));
});
