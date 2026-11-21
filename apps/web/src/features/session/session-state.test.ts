import type { AgentDetail, EventsPage, SessionEvent } from "@open-factory/shared";
import { expect, test, vi } from "vitest";
import { agentSummary } from "@/test/session-fixtures";
import {
  eventsInOrder,
  highestSeq,
  initialSessionState,
  queueView,
  type SessionState,
  sessionReducer,
} from "./session-state";

const ev = (seq: number): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId: null,
  at: "2026-11-18T00:00:00.000Z",
  event: { type: "turn_started" },
});
const page = (seqs: number[], hasMore = { before: false, after: false }): EventsPage => ({
  events: seqs.map(ev),
  hasMore,
});
const noRestart = { restartPending: false, restartWaitingOn: 0 } as const;
const detail: AgentDetail = {
  agent: agentSummary(),
  queue: [],
  lastSeq: 9,
};

test("latest mode appends live events and ignores duplicates", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([7, 8, 9], { before: true, after: false }),
    detail,
    mode: "latest",
  });
  s = sessionReducer(s, {
    type: "frame",
    message: { type: "session_event", agent: "dev", event: ev(10) },
  });
  s = sessionReducer(s, {
    type: "frame",
    message: { type: "session_event", agent: "dev", event: ev(10) },
  });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  expect(highestSeq(s)).toBe(10);
  expect(s.hasMoreBefore).toBe(true);
});

test("window mode counts live events instead of appending them", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([3, 4, 5], { before: true, after: true }),
    detail,
    mode: "window",
  });
  s = sessionReducer(s, {
    type: "frame",
    message: { type: "session_event", agent: "dev", event: ev(10) },
  });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([3, 4, 5]);
  expect(s.newWhileAway).toBe(1);
});

test("earlier pages prepend; status, queue and resync frames", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([7, 8, 9], { before: true, after: false }),
    detail,
    mode: "latest",
  });
  s = sessionReducer(s, { type: "earlier", page: page([5, 6], { before: false, after: true }) });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
  expect(s.hasMoreBefore).toBe(false);
  s = sessionReducer(s, {
    type: "frame",
    message: {
      type: "agent_status",
      agent: "dev",
      status: "working",
      turnOpen: true,
      ...noRestart,
    },
  });
  expect(s.agent?.status).toBe("working");
  expect(s.agent?.turnOpen).toBe(true);
  s = sessionReducer(s, {
    type: "frame",
    message: {
      type: "queue",
      agent: "dev",
      items: [{ id: "q", kind: "compact", from: "@or", createdAt: "x" }],
    },
  });
  expect(s.queue).toHaveLength(1);
  s = sessionReducer(s, { type: "frame", message: { type: "resync", agent: "dev" } });
  expect(s.needsReload).toBe(true);
});

test("frames for other agents are ignored", () => {
  const s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([1]),
    detail,
    mode: "latest",
  });
  expect(
    sessionReducer(s, {
      type: "frame",
      message: { type: "session_event", agent: "other", event: ev(2) },
    }),
  ).toBe(s);
});

const loadedLatest = () =>
  sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([7, 8, 9]),
    detail,
    mode: "latest",
  });
const frame = (
  message: Parameters<typeof sessionReducer>[1] extends infer A
    ? A extends { type: "frame"; message: infer M }
      ? M
      : never
    : never,
) => ({ type: "frame", message }) as const;

test("loaded replaces everything, including needsReload and newWhileAway; reset clears", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([3, 4], { before: false, after: true }),
    detail,
    mode: "window",
  });
  s = sessionReducer(s, frame({ type: "session_event", agent: "dev", event: ev(20) }));
  s = sessionReducer(s, frame({ type: "resync", agent: "dev" }));
  expect(s.newWhileAway).toBe(1);
  expect(s.needsReload).toBe(true);
  s = sessionReducer(s, { type: "loaded", page: page([7, 8, 9]), detail, mode: "latest" });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([7, 8, 9]);
  expect(s.needsReload).toBe(false);
  expect(s.newWhileAway).toBe(0);
  expect(s.windowed).toBe(false);
  expect(sessionReducer(s, { type: "reset" })).toBe(initialSessionState);
});

test("a duplicate in an earlier page is deduplicated", () => {
  let s = loadedLatest();
  s = sessionReducer(s, { type: "earlier", page: page([6, 7]) });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([6, 7, 8, 9]);
});

test("window mode ignores an already-present live event without counting it", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([3, 4, 5], { before: false, after: true }),
    detail,
    mode: "window",
  });
  s = sessionReducer(s, frame({ type: "session_event", agent: "dev", event: ev(4) }));
  expect(s.newWhileAway).toBe(0);
});

test("an agent_status frame without lastError clears the previous one", () => {
  let s = loadedLatest();
  s = sessionReducer(
    s,
    frame({
      type: "agent_status",
      agent: "dev",
      status: "errored",
      turnOpen: false,
      lastError: "boom",
      ...noRestart,
    }),
  );
  expect(s.agent?.lastError).toBe("boom");
  s = sessionReducer(
    s,
    frame({ type: "agent_status", agent: "dev", status: "idle", turnOpen: false, ...noRestart }),
  );
  expect(s.agent?.lastError).toBeUndefined();
});

test("highestSeq of empty state is 0", () => {
  expect(highestSeq(initialSessionState)).toBe(0);
});

test("highestSeq handles more events than Math.max can take as arguments", () => {
  const events = new Map(Array.from({ length: 300_000 }, (_, i) => [i + 1, {}] as const));
  const s = { ...initialSessionState, events } as unknown as typeof initialSessionState;
  expect(highestSeq(s)).toBe(300_000);
});

test("window mode counts each live seq once, even when a reconnect replays it", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([4, 5, 6], { before: true, after: true }),
    detail,
    mode: "window",
  });
  expect(s.maxSeenSeq).toBe(9);
  const frame = (seq: number) =>
    sessionReducer(s, {
      type: "frame",
      message: { type: "session_event", agent: "dev", event: ev(seq) },
    });
  s = frame(9); // at or below lastSeq: not new
  s = frame(10);
  s = frame(11);
  s = frame(10); // replayed after a reconnect
  s = frame(11);
  expect(s.newWhileAway).toBe(2);
  expect(s.maxSeenSeq).toBe(11);
});

const qItem = (id: string) => ({
  id,
  kind: "message" as const,
  body: id,
  urgent: false,
  from: "@or",
  createdAt: "2026-11-18T00:00:00.000Z",
});

test("a locally queued item is added once and the next queue frame overrides it", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([1]),
    detail,
    mode: "latest",
  });
  s = sessionReducer(s, { type: "queued", item: qItem("q1") });
  s = sessionReducer(s, { type: "queued", item: qItem("q1") });
  expect(s.queue.map((q) => q.id)).toEqual(["q1"]);
  s = sessionReducer(s, {
    type: "frame",
    message: { type: "queue", agent: "dev", items: [qItem("q2")] },
  });
  expect(s.queue.map((q) => q.id)).toEqual(["q2"]);
});

const liveFrame = (seq: number) =>
  ({ type: "session_event", agent: "dev", event: ev(seq) }) as const;

test("a single live event above the max appends without sorting, keeping the prefix", () => {
  const s = loadedLatest();
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const next = sessionReducer(s, frame(liveFrame(10)));
    expect(sort).not.toHaveBeenCalled();
    for (const [i, e] of s.ordered.entries()) expect(next.ordered[i]).toBe(e);
    expect(next.ordered.map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  } finally {
    sort.mockRestore();
  }
});

test("a seq repeated within one batch is inserted once", () => {
  const s = loadedLatest();
  const next = sessionReducer(s, {
    type: "frames",
    messages: [liveFrame(10), liveFrame(10)],
  });
  expect(next.ordered.map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  expect(next.events.size).toBe(s.events.size + 1);
});

test("an earlier page sorts once", () => {
  const s = loadedLatest();
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const next = sessionReducer(s, { type: "earlier", page: page([5, 6]) });
    expect(next.ordered.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    // at most one sort of the fresh slice and one of the whole set
    expect(sort.mock.calls.length).toBeLessThanOrEqual(2);
    expect(sort.mock.contexts.filter((c) => (c as unknown[]).length === 5)).toHaveLength(1);
  } finally {
    sort.mockRestore();
  }
});

test("a frames batch copies the map once and equals single frame dispatches", () => {
  const s = loadedLatest();
  const messages = [liveFrame(10), liveFrame(11), liveFrame(12)];
  let copies = 0;
  const RealMap = Map;
  vi.stubGlobal(
    "Map",
    class CountingMap<K, V> extends RealMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries);
        copies++;
      }
    },
  );
  let batched: typeof s;
  try {
    batched = sessionReducer(s, { type: "frames", messages });
  } finally {
    vi.unstubAllGlobals();
  }
  expect(copies).toBe(1);
  const single = messages.reduce((acc, m) => sessionReducer(acc, frame(m)), s);
  expect(batched.ordered.map((e) => e.seq)).toEqual(single.ordered.map((e) => e.seq));
  expect([...batched.events.keys()].sort()).toEqual([...single.events.keys()].sort());
  expect({ ...batched, events: undefined, ordered: undefined }).toEqual({
    ...single,
    events: undefined,
    ordered: undefined,
  });
});

test("a frames batch mixes status, queue and window counting like single frames", () => {
  const s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([3, 4, 5], { before: true, after: true }),
    detail,
    mode: "window",
  });
  const messages = [
    liveFrame(10),
    {
      type: "agent_status",
      agent: "dev",
      status: "working",
      turnOpen: true,
      ...noRestart,
    } as const,
    liveFrame(11),
    { type: "session_event", agent: "other", event: ev(12) } as const,
  ];
  const batched = sessionReducer(s, { type: "frames", messages });
  const single = messages.reduce((acc, m) => sessionReducer(acc, frame(m)), s);
  expect(batched).toEqual(single);
  expect(batched.newWhileAway).toBe(2);
  expect(batched.ordered).toBe(s.ordered);
});

test("an agent_status frame keeps events and ordered identical", () => {
  const s = loadedLatest();
  const next = sessionReducer(
    s,
    frame({ type: "agent_status", agent: "dev", status: "working", turnOpen: true, ...noRestart }),
  );
  expect(next.events).toBe(s.events);
  expect(next.ordered).toBe(s.ordered);
  expect(eventsInOrder(next)).toBe(eventsInOrder(s));
});

test("an out-of-order live event is placed by seq", () => {
  let s = loadedLatest();
  s = sessionReducer(s, frame(liveFrame(12)));
  s = sessionReducer(s, frame(liveFrame(10)));
  expect(s.ordered.map((e) => e.seq)).toEqual([7, 8, 9, 10, 12]);
});

const status = (turnOpen: boolean) =>
  ({
    type: "agent_status",
    agent: "dev",
    status: turnOpen ? "working" : "idle",
    turnOpen,
    ...noRestart,
  }) as const;

test("turnEpoch counts every turn edge, even a close and reopen folded into one batch", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([7, 8, 9]),
    detail: { ...detail, agent: agentSummary({ status: "working", turnOpen: true }) },
    mode: "latest",
  });
  const start = s.turnEpoch;
  s = sessionReducer(s, { type: "frames", messages: [status(false), status(true)] });
  expect(s.agent?.turnOpen).toBe(true);
  expect(s.turnEpoch).toBe(start + 2);
  s = sessionReducer(s, frame(status(true)));
  expect(s.turnEpoch).toBe(start + 2);
  s = sessionReducer(s, { type: "agent", agent: agentSummary({ turnOpen: false }) });
  expect(s.turnEpoch).toBe(start + 3);
  // a reload carries the epoch on rather than restarting it
  s = sessionReducer(s, { type: "loaded", page: page([7, 8, 9]), detail, mode: "latest" });
  expect(s.turnEpoch).toBe(start + 3);
});

test("a frames batch of already-held events returns the same state", () => {
  const s = loadedLatest();
  expect(sessionReducer(s, { type: "frames", messages: [liveFrame(8), liveFrame(9)] })).toBe(s);
});

// U3 §8.3, §5.3: handoffs, liveAfter and the one-commit turn end.
const at = "2026-11-21T10:00:00.000Z";
const sessionEvent = (seq: number, event: SessionEvent["event"]): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId: "t1",
  at,
  event,
});
const messageIn = (...ids: string[]): SessionEvent["event"] => ({
  type: "message_in",
  messages: ids.map((id) => ({ id, from: "@or", kind: "message", urgent: false, body: id })),
});
const turnEnd = (): SessionEvent["event"] => ({ type: "turn_end", isError: false, numTurns: 1 });
const loaded = (
  o: { queue?: AgentDetail["queue"]; agent?: Partial<AgentDetail["agent"]>; seqs?: number[] } = {},
  mode: "latest" | "window" = "latest",
) =>
  sessionReducer(initialSessionState, {
    type: "loaded",
    page: page(o.seqs ?? [7, 8, 9], { before: false, after: mode === "window" }),
    detail: { agent: agentSummary(o.agent), queue: o.queue ?? [], lastSeq: 9 },
    mode,
  });
const frames = (events: SessionEvent[]) => ({
  type: "frames" as const,
  messages: events.map((event) => ({ type: "session_event" as const, agent: "dev", event })),
});

test("a message_in matching a queue item removes it in the same step and marks the row handed off", () => {
  const s1 = sessionReducer(
    loaded({ queue: [qItem("m8"), qItem("m9")] }),
    frames([sessionEvent(10, messageIn("m7", "m9"))]),
  );
  expect(s1.queue.map((q) => q.id)).toEqual(["m8"]);
  expect(s1.handedOff.has("10:1")).toBe(true);
  expect(s1.handedOff.has("10:0")).toBe(false);
  // A single frame does the same.
  const s2 = sessionReducer(loaded({ queue: [qItem("m9")] }), {
    type: "frame",
    message: { type: "session_event", agent: "dev", event: sessionEvent(10, messageIn("m9")) },
  });
  expect(s2.queue).toEqual([]);
  expect(s2.handedOff.has("10:0")).toBe(true);
});

test("a merged envelope's ids hand off every matching queue item", () => {
  const ev10 = sessionEvent(10, {
    type: "message_in",
    messages: [
      { id: "m1", ids: ["m1", "m2"], from: "@or", kind: "message", urgent: false, body: "x" },
    ],
  });
  const s = sessionReducer(loaded({ queue: [qItem("m1"), qItem("m2")] }), frames([ev10]));
  expect(s.queue).toEqual([]);
  expect(s.handedOff.has("10:0")).toBe(true);
});

test("applying a live turn_end closes the turn in the same step", () => {
  const s0 = loaded({ agent: { turnOpen: true, turnStartedAt: at, status: "working" } });
  const s = sessionReducer(s0, frames([sessionEvent(20, turnEnd())]));
  expect(s.agent?.turnOpen).toBe(false);
  expect(s.agent?.turnStartedAt).toBeUndefined();
  expect(s.turnEpoch).toBe(s0.turnEpoch + 1);
});

test("a live interrupt_unconfirmed bumps stopEpoch (Stop resets) but not turnEpoch; turn edges bump both", () => {
  const s0 = loaded({ agent: { turnOpen: true, turnStartedAt: at, status: "working" } });
  const s1 = sessionReducer(s0, frames([sessionEvent(20, { type: "interrupt_unconfirmed" })]));
  expect(s1.stopEpoch).toBe(s0.stopEpoch + 1);
  expect(s1.turnEpoch).toBe(s0.turnEpoch);
  expect(s1.agent?.turnOpen).toBe(true);
  const s2 = sessionReducer(s1, frames([sessionEvent(21, turnEnd())]));
  expect(s2.turnEpoch).toBe(s1.turnEpoch + 1);
  expect(s2.stopEpoch).toBe(s1.stopEpoch + 1);
  // A replayed (already-held) one changes nothing.
  expect(
    sessionReducer(s2, frames([sessionEvent(20, { type: "interrupt_unconfirmed" })])).stopEpoch,
  ).toBe(s2.stopEpoch);
});

test("a loaded turn_end never flips turnOpen", () => {
  const s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: { events: [sessionEvent(5, turnEnd())], hasMore: { before: false, after: false } },
    detail: { agent: agentSummary({ turnOpen: true, turnStartedAt: at }), queue: [], lastSeq: 9 },
    mode: "latest",
  });
  expect(s.agent?.turnOpen).toBe(true);
  // Nor does an earlier page.
  const e = sessionReducer(s, {
    type: "earlier",
    page: { events: [sessionEvent(2, turnEnd())], hasMore: { before: false, after: false } },
  });
  expect(e.agent?.turnOpen).toBe(true);
});

test("a windowed view's live turn_end only counts", () => {
  const s0 = loaded({ agent: { turnOpen: true, turnStartedAt: at } }, "window");
  const s = sessionReducer(s0, frames([sessionEvent(20, turnEnd())]));
  expect(s.agent?.turnOpen).toBe(true);
  expect(s.newWhileAway).toBe(1);
});

test("a status frame without turnStartedAt or compacting clears them", () => {
  const s0 = loaded({ agent: { turnOpen: true, turnStartedAt: at, compacting: true } });
  const s = sessionReducer(s0, {
    type: "frame",
    message: { type: "agent_status", agent: "dev", status: "idle", turnOpen: false, ...noRestart },
  });
  expect(s.agent?.turnStartedAt).toBeUndefined();
  expect(s.agent?.compacting).toBeUndefined();
});

test("liveAfter moves on load, caught_up and visible", () => {
  let s = loaded();
  expect(s.liveAfter).toBe(9);
  s = sessionReducer(s, frames([sessionEvent(10, { type: "assistant_text", text: "a" })]));
  expect(s.liveAfter).toBe(9);
  s = sessionReducer(s, { type: "caught_up" });
  expect(s.liveAfter).toBe(10);
  s = sessionReducer(s, frames([sessionEvent(11, { type: "assistant_text", text: "b" })]));
  expect(s.liveAfter).toBe(10);
  s = sessionReducer(s, { type: "visible" });
  expect(s.liveAfter).toBe(11);
  // Nothing new: the same state, so React bails out.
  expect(sessionReducer(s, { type: "visible" })).toBe(s);
});

test("a commit appending more than 10 rows is not live", () => {
  const text = (seq: number) => sessionEvent(seq, { type: "assistant_text", text: `${seq}` });
  const ten = sessionReducer(loaded(), frames(Array.from({ length: 10 }, (_, i) => text(10 + i))));
  expect(ten.liveAfter).toBe(9);
  const eleven = sessionReducer(
    loaded(),
    frames(Array.from({ length: 11 }, (_, i) => text(10 + i))),
  );
  expect(eleven.liveAfter).toBe(20);
});

test("a new load starts with no handoffs", () => {
  const s1 = sessionReducer(
    loaded({ queue: [qItem("m9")] }),
    frames([sessionEvent(10, messageIn("m9"))]),
  );
  const s2 = sessionReducer(s1, {
    type: "loaded",
    page: page([7, 8, 9, 10]),
    detail,
    mode: "latest",
  });
  expect(s2.handedOff.size).toBe(0);
  expect(s2.liveAfter).toBe(10);
});

test("a windowed view counts speech in newSpeech: messages, agent text and sends, not tools or member updates", () => {
  const s0 = loaded({}, "window");
  const msgIn = (kinds: string[]): SessionEvent["event"] =>
    ({
      type: "message_in",
      messages: kinds.map((kind, i) => ({
        id: `m${i}`,
        from: "@or",
        kind,
        urgent: false,
        body: "x",
      })),
    }) as SessionEvent["event"];
  const s = sessionReducer(
    s0,
    frames([
      sessionEvent(20, { type: "assistant_text", text: "hi" }),
      sessionEvent(21, msgIn(["message", "member_update"])),
      sessionEvent(22, {
        type: "tool_call",
        toolUseId: "t1",
        name: "mcp__factory__send_message",
        input: { to: "@or", body: "done" },
      } as SessionEvent["event"]),
      sessionEvent(23, {
        type: "tool_call",
        toolUseId: "t2",
        name: "Bash",
        input: {},
      } as SessionEvent["event"]),
      sessionEvent(24, turnEnd()),
    ]),
  );
  expect(s.newWhileAway).toBe(5);
  expect(s.newSpeech).toBe(3);
  // A reload starts the count again.
  expect(loaded({}, "window").newSpeech).toBe(0);
});

// U3 §6.4: Cancel a held message, with Undo.
const queueFrame = (ids: string[]) =>
  ({ type: "queue", agent: "dev", items: ids.map(qItem) }) as const;
const withQueue = (ids: string[]) =>
  sessionReducer(
    sessionReducer(initialSessionState, {
      type: "loaded",
      page: page([1]),
      detail,
      mode: "latest",
    }),
    { type: "frame", message: queueFrame(ids) },
  );
/** What the queue renders: item ids, and `x:<id>` for a cancelled line (`!` when it says why). */
const view = (s: SessionState) =>
  queueView(s.queue, s.cancelled).map((v) =>
    v.kind === "item"
      ? `${v.item.id}${v.error ? `!${v.error}` : ""}`
      : `x:${v.id}${v.entry.error ? "!" : ""}${v.entry.inBox ? "+box" : ""}`,
  );

test("cancel takes the item off and puts the line in its place, in one step", () => {
  let s = withQueue(["a", "b", "c"]);
  s = sessionReducer(s, { type: "cancel", id: "b", inBox: true });
  expect(view(s)).toEqual(["a", "x:b+box", "c"]);
  expect(s.cancelled.get("b")?.item.body).toBe("b");
});

test("the cancelled line is the same whichever of the DELETE response and the queue frame comes first", () => {
  const cancelled = sessionReducer(withQueue(["a", "b", "c"]), { type: "cancel", id: "b" });
  // A frame still listing it (the server hadn't cancelled yet), then the one without it.
  const stale = sessionReducer(cancelled, { type: "frame", message: queueFrame(["a", "b", "c"]) });
  expect(view(stale)).toEqual(["a", "x:b", "c"]);
  const fresh = sessionReducer(stale, { type: "frame", message: queueFrame(["a", "c"]) });
  expect(view(fresh)).toEqual(["a", "x:b", "c"]);
  // Nothing to do for the 200: the optimistic step already showed it.
  expect(
    view(sessionReducer(cancelled, { type: "frame", message: queueFrame(["a", "c"]) })),
  ).toEqual(["a", "x:b", "c"]);
});

test("a failed cancel rolls back: the item is back with the reason under it", () => {
  let s = sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" });
  s = sessionReducer(s, { type: "cancel_failed", id: "b", error: "Already delivered" });
  expect(view(s)).toEqual(["a", "b!Already delivered"]);
});

test("Undo: the restored item and the line's removal land in one step, frame first or response first", () => {
  const base = sessionReducer(sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" }), {
    type: "frame",
    message: queueFrame(["a"]),
  });
  // The frame with the item comes before the 204: the item stays hidden behind the line until then.
  const frameFirst = sessionReducer(base, { type: "frame", message: queueFrame(["a", "b"]) });
  expect(view(frameFirst)).toEqual(["a", "x:b"]);
  const done1 = sessionReducer(frameFirst, { type: "restored", id: "b" });
  expect(view(done1)).toEqual(["a", "b"]);
  expect(done1.cancelled.size).toBe(0);
  // The 204 comes first: the line stays until the frame brings the item back.
  const responseFirst = sessionReducer(base, { type: "restored", id: "b" });
  expect(view(responseFirst)).toEqual(["a", "x:b"]);
  const done2 = sessionReducer(responseFirst, { type: "frame", message: queueFrame(["a", "b"]) });
  expect(view(done2)).toEqual(["a", "b"]);
  expect(done2.cancelled.size).toBe(0);
});

test("a failed restore keeps the line and says why", () => {
  let s = sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["a"]) });
  s = sessionReducer(s, { type: "restore_failed", id: "b", error: "This agent has ended" });
  expect(view(s)).toEqual(["a", "x:b!"]);
  expect(s.cancelled.get("b")?.error).toBe("This agent has ended");
});

test("the line goes on your next send, and survives a reload of the same session", () => {
  let s = sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["a"]) });
  const reloaded = sessionReducer(s, {
    type: "loaded",
    page: page([1]),
    detail: { ...detail, queue: [qItem("a")] },
    mode: "latest",
  });
  expect(view(reloaded)).toEqual(["a", "x:b"]);
  s = sessionReducer(s, { type: "clear_cancelled" });
  expect(view(s)).toEqual(["a"]);
});

test("a second cancel of the same item, or of one not queued, changes nothing", () => {
  const s = sessionReducer(withQueue(["a"]), { type: "cancel", id: "a" });
  expect(sessionReducer(s, { type: "cancel", id: "a" })).toBe(s);
  expect(sessionReducer(s, { type: "cancel", id: "zz" })).toBe(s);
});

// U3 §13.2: optimistic "Sending" blocks, handed off by clientMessageId.
const CID = "0b6f7b5e-8d0f-4a39-9a5d-1f1f3a1c2b01";
const block = { clientMessageId: CID, body: "hello", urgent: false };
const echoItem = (id: string) => ({ ...qItem(id), body: "hello", clientMessageId: CID });
const sendingState = () => sessionReducer(withQueue([]), { type: "sending", block });

test("a sending block is added once and a failure removes it", () => {
  const s = sendingState();
  expect(s.sending).toEqual([block]);
  expect(sessionReducer(s, { type: "sending", block })).toBe(s);
  const failed = sessionReducer(s, { type: "send_failed", clientMessageId: CID });
  expect(failed.sending).toEqual([]);
  expect(failed.landed.has(CID)).toBe(false);
});

test("the 202's item replaces the block in one step, connected or not", () => {
  for (const live of [true, false]) {
    const s = sessionReducer(sendingState(), { type: "queued", item: echoItem("m1"), live });
    expect(s.sending).toEqual([]);
    expect(s.queue.map((q) => q.id)).toEqual(["m1"]);
    expect(s.landed.has(CID)).toBe(true);
  }
});

test("while connected, a 202 with no block left (already delivered) adds nothing", () => {
  const s = withQueue([]);
  expect(sessionReducer(s, { type: "queued", item: qItem("m1"), live: true })).toBe(s);
});

test("a queue frame echoing the id replaces the block in one step", () => {
  const s = sessionReducer(sendingState(), {
    type: "frame",
    message: { type: "queue", agent: "dev", items: [echoItem("m1")] },
  });
  expect(s.sending).toEqual([]);
  expect(s.queue.map((q) => q.id)).toEqual(["m1"]);
  // The 202 that follows changes nothing.
  expect(sessionReducer(s, { type: "queued", item: echoItem("m1"), live: true }).queue).toBe(
    s.queue,
  );
});

test("a message_in echoing the id removes the block and its row is handed off", () => {
  const ev10 = sessionEvent(10, {
    type: "message_in",
    messages: [
      {
        id: "m1",
        from: "@or",
        kind: "message",
        urgent: false,
        body: "hello",
        clientMessageId: CID,
      },
    ],
  });
  const s = sessionReducer(sendingState(), frames([ev10]));
  expect(s.sending).toEqual([]);
  expect(s.handedOff.has("10:0")).toBe(true);
  expect(s.landed.has(CID)).toBe(true);
});

test("an unconfirmed send (15s abort) is remembered, and a late echo marks it landed", () => {
  let s = sessionReducer(sendingState(), {
    type: "send_failed",
    clientMessageId: CID,
    unconfirmed: true,
  });
  expect(s.sending).toEqual([]);
  expect(s.landed.has(CID)).toBe(false);
  const ev10 = sessionEvent(10, {
    type: "message_in",
    messages: [
      {
        id: "m1",
        from: "@or",
        kind: "message",
        urgent: false,
        body: "hello",
        clientMessageId: CID,
      },
    ],
  });
  s = sessionReducer(s, frames([ev10]));
  expect(s.landed.has(CID)).toBe(true);
  // Unrelated echoes don't mark anything.
  const other = sessionReducer(withQueue([]), {
    type: "frame",
    message: { type: "queue", agent: "dev", items: [echoItem("m1")] },
  });
  expect(other.landed.size).toBe(0);
});

test("a retry's 202 for an item you cancelled doesn't put it back in the queue", () => {
  let s = sessionReducer(withQueue([]), {
    type: "frame",
    message: { type: "queue", agent: "dev", items: [echoItem("m1")] },
  });
  s = sessionReducer(s, { type: "cancel", id: "m1" });
  s = sessionReducer(s, { type: "frame", message: queueFrame([]) });
  s = sessionReducer(s, { type: "sending", block });
  s = sessionReducer(s, { type: "queued", item: echoItem("m1"), live: true });
  expect(s.sending).toEqual([]);
  expect(view(s)).toEqual(["x:m1"]);
});

test("a reload of the same session keeps the blocks; another session drops them", () => {
  const s = sendingState();
  const same = sessionReducer(s, { type: "loaded", page: page([1]), detail, mode: "latest" });
  expect(same.sending).toEqual([block]);
  const other = sessionReducer(s, {
    type: "loaded",
    page: page([1]),
    detail: { ...detail, agent: agentSummary({ slug: "ops" }) },
    mode: "latest",
  });
  expect(other.sending).toEqual([]);
});

test("cancel_failed after the frame already dropped the item keeps a line with the reason", () => {
  let s = sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["a"]) }); // delivered first
  s = sessionReducer(s, { type: "cancel_failed", id: "b", error: "Already delivered." });
  expect(view(s)).toEqual(["a", "x:b!"]);
  // Your next send clears it.
  expect(view(sessionReducer(s, { type: "clear_cancelled" }))).toEqual(["a"]);
});

test("a reload that already lists a restored item drops its line", () => {
  let s = sessionReducer(withQueue(["a", "b"]), { type: "cancel", id: "b" });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["a"]) });
  s = sessionReducer(s, { type: "restored", id: "b" });
  expect(view(s)).toEqual(["a", "x:b"]);
  s = sessionReducer(s, {
    type: "loaded",
    page: page([1]),
    detail: { ...detail, queue: [qItem("a"), qItem("b")] },
    mode: "latest",
  });
  expect(view(s)).toEqual(["a", "b"]);
  expect(s.cancelled.size).toBe(0);
});
