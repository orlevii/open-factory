import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";
import { rawTailRows } from "./raw-tail";
import { buildRows } from "./rows";
import { SLOW_SEND_MS, YOUNG_ITEM_MS } from "./send-phase";
import { Timeline } from "./timeline";

/** An agent speaker links to its session; a plain anchor stands in for the router's Link. */
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="/x" className={className}>
      {children}
    </a>
  ),
}));

const person = (ref: string, handle: string) => ({
  id: `id-${ref}`,
  ref,
  kind: "human",
  handle,
  name: handle,
  state: "live",
  avatar: null,
});
beforeEach(() => {
  mockApi({
    "GET /api/principals": () =>
      json({ principals: [person("a1ce0001", "alice"), person("b0b00001", "bob")] }),
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(new Date(2026, 10, 19, 14, 0));
});
afterEach(() => vi.useRealTimers());

const CID = "5b1f1c1e-0000-4c1a-9a43-1d1f6f8f2a10";
const ALICE = "<@a1ce0001>";
const BOB = "<@b0b00001>";
const queueItem = {
  id: "q1",
  kind: "raw",
  from: ALICE,
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
      by: ALICE,
      byKind: "human",
      clientMessageId: CID,
      entryId: "e1",
    },
  },
] as never;

const view = (o: { rows?: never; pending?: ReturnType<typeof rawTailRows> }) => (
  <QueryClientProvider client={createQueryClient({ queries: { retry: false } })}>
    <TooltipProvider>
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
    </TooltipProvider>
  </QueryClientProvider>
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
  const { rerender } = render(view({ pending: rawTailRows([], [block], none, ALICE, undefined) }));
  observe();
  expect(screen.getByRole("group", { name: "Sending" })).toBeInTheDocument();
  rerender(view({ pending: rawTailRows([queueItem], [], none, ALICE, () => {}) }));
  observe();
  rerender(view({ rows: operatorInput }));
  observe();
  expect(document.querySelector("[data-speaker-line]")).not.toBeNull();
  expect(mount).toHaveBeenCalledTimes(1);
});

test("the block says raw and keeps the text as typed", () => {
  render(view({ pending: rawTailRows([queueItem], [], new Map(), ALICE, undefined) }));
  expect(screen.getByText("· raw")).toBeInTheDocument();
  expect(screen.getByText("/context")).toBeInTheDocument();
});

test("Sending… and Runs after… stay hidden on a fast path", () => {
  const none = new Map();
  const { rerender } = render(view({ pending: rawTailRows([], [block], none, ALICE, undefined) }));
  act(() => vi.advanceTimersByTime(SLOW_SEND_MS - 50));
  expect(screen.queryByText("Sending…")).toBeNull();
  rerender(view({ pending: rawTailRows([queueItem], [], none, ALICE, undefined) }));
  expect(screen.queryByText("Runs after the current turn.")).toBeNull();
  act(() => vi.advanceTimersByTime(YOUNG_ITEM_MS + 50));
  expect(screen.getByText("Runs after the current turn.")).toBeInTheDocument();
});

test("a slow send says Sending…", () => {
  render(view({ pending: rawTailRows([], [block], new Map(), ALICE, undefined) }));
  act(() => vi.advanceTimersByTime(SLOW_SEND_MS + 10));
  expect(screen.getByText("Sending…")).toBeInTheDocument();
});

test("Cancel is on your own queued raw block only", () => {
  const onCancel = vi.fn();
  const theirs = {
    ...(queueItem as object),
    id: "q2",
    from: BOB,
    clientMessageId: "other",
  } as never;
  render(view({ pending: rawTailRows([queueItem, theirs], [], new Map(), ALICE, onCancel) }));
  const buttons = screen.getAllByRole("button", { name: "Cancel" });
  expect(buttons).toHaveLength(1);
  act(() => buttons[0]?.click());
  expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }));
});

test("two sends show oldest first, whatever order they were queued in", () => {
  const later = {
    ...(queueItem as object),
    id: "q2",
    body: "second",
    clientMessageId: "c-2",
    createdAt: new Date(2026, 10, 19, 14, 0, 5).toISOString(),
  } as never;
  const early = { ...(queueItem as object), body: "first" } as never;
  const rows = rawTailRows([later, early], [], new Map(), ALICE, undefined);
  expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
  const sendingFirst = rawTailRows(
    [later],
    [{ ...block, at: new Date(2026, 10, 19, 14, 0, 1).toISOString(), body: "sending" }],
    new Map(),
    ALICE,
    undefined,
  );
  expect(sendingFirst.map((r) => r.text)).toEqual(["sending", "second"]);
});

// An agent's raw input (`send_command`) has no clientMessageId: the queue item's id is the entry id.
const agentItem = {
  id: "e9",
  kind: "raw",
  from: "@lead",
  fromKind: "agent",
  body: "/context",
  createdAt: new Date(2026, 10, 19, 14, 0).toISOString(),
} as never;
const agentInput = [
  {
    seq: 6,
    agentSlug: "dev",
    turnId: null,
    at: "2026-11-19T14:00:01.000Z",
    event: {
      type: "operator_input",
      text: "/context",
      by: "@lead",
      byKind: "agent",
      entryId: "e9",
    },
  },
] as never;

test("an agent's raw input shows the agent as the speaker, not a human", () => {
  const { container } = render(view({ rows: agentInput }));
  expect(screen.getByText("· raw")).toBeInTheDocument();
  expect(container.textContent).toContain("lead");
  const rows = buildRows(agentInput).rows;
  expect(rows[0]).toMatchObject({ kind: "command", fromKind: "agent" });
  expect(rawTailRows([agentItem], [], new Map(), ALICE, undefined)[0]).toMatchObject({
    fromKind: "agent",
  });
});

test("a queued agent raw item keeps its node into the timeline row", () => {
  const mount = vi.fn();
  const seen = new Set<Element>();
  const observe = () => {
    for (const el of document.querySelectorAll("[data-message-block]")) {
      if (!seen.has(el)) mount();
      seen.add(el);
    }
  };
  const { rerender } = render(
    view({ pending: rawTailRows([agentItem], [], new Map(), ALICE, undefined) }),
  );
  observe();
  rerender(view({ rows: agentInput }));
  observe();
  expect(mount).toHaveBeenCalledTimes(1);
  expect(rawTailRows([agentItem], [], new Map(), ALICE, undefined)[0]?.key).toBe(
    buildRows(agentInput).rows[0]?.key,
  );
});

test("a command row names its sender by tag, shown by the sender's current handle", async () => {
  vi.useRealTimers();
  render(view({ rows: operatorInput }));
  expect(await screen.findByText(/@alice/, { selector: "span" })).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(ALICE);
});
