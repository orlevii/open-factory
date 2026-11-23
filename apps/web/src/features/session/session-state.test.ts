import {
  type AgentDetail,
  type EventsPage,
  liveKey,
  type ServerMessage,
  type SessionEvent,
} from "@open-factory/shared";
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
      items: [{ id: "q", kind: "compact", from: "@or", fromKind: "human", createdAt: "x" }],
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

test("loaded replaces everything, including needsReload; reset clears", () => {
  let s = sessionReducer(initialSessionState, {
    type: "loaded",
    page: page([3, 4], { before: false, after: true }),
    detail,
    mode: "window",
  });
  s = sessionReducer(s, frame({ type: "session_event", agent: "dev", event: ev(20) }));
  s = sessionReducer(s, frame({ type: "resync", agent: "dev" }));
  expect(s.needsReload).toBe(true);
  s = sessionReducer(s, { type: "loaded", page: page([7, 8, 9]), detail, mode: "latest" });
  expect(eventsInOrder(s).map((e) => e.seq)).toEqual([7, 8, 9]);
  expect(s.needsReload).toBe(false);
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
  expect(s.maxSeenSeq).toBe(11);
});

const qItem = (id: string) => ({
  id,
  kind: "message" as const,
  body: id,
  urgent: false,
  from: "@or",
  fromKind: "human" as const,
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
  messages: ids.map((id) => ({
    id,
    from: "@or",
    fromKind: "human",
    kind: "message",
    urgent: false,
    body: id,
  })),
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
      {
        id: "m1",
        ids: ["m1", "m2"],
        from: "@or",
        fromKind: "human",
        kind: "message",
        urgent: false,
        body: "x",
      },
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
        input: { to: ["@or"], body: "done" },
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

test("cancelled lines keep their place when an earlier queue entry leaves, and after an Undo", () => {
  let s = withQueue(["compact", "m1", "m2", "m3"]);
  s = sessionReducer(s, { type: "cancel", id: "m2" });
  s = sessionReducer(s, { type: "cancel", id: "m1" });
  expect(view(s)).toEqual(["compact", "x:m1", "x:m2", "m3"]);
  // The compaction starts: its entry leaves the front of the queue.
  s = sessionReducer(s, { type: "frame", message: queueFrame(["m3"]) });
  expect(view(s)).toEqual(["x:m1", "x:m2", "m3"]);
  // Undo of m1 brings it back where it was: m2's line stays after it.
  s = sessionReducer(s, { type: "restored", id: "m1" });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["m1", "m3"]) });
  expect(view(s)).toEqual(["m1", "x:m2", "m3"]);
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
        fromKind: "human",
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
        fromKind: "human",
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

test("an Undo the server delivers at once leaves no cancelled line (frames before the 204)", () => {
  let s = withQueue(["m1"]);
  s = sessionReducer(s, { type: "cancel", id: "m1", inBox: true });
  s = sessionReducer(s, { type: "frame", message: queueFrame([]) });
  s = sessionReducer(s, { type: "frame", message: queueFrame(["m1"]) });
  s = sessionReducer(s, { type: "frame", message: queueFrame([]) });
  s = sessionReducer(s, frames([sessionEvent(10, messageIn("m1"))]));
  expect(s.cancelled.size).toBe(0);
  s = sessionReducer(s, { type: "restored", id: "m1" });
  expect(s.cancelled.size).toBe(0);
  expect(view(s)).toEqual([]);
});

// U3 §11.4: live text in the reducer.
type LiveMsg = Extract<ServerMessage, { type: "live" }>;
const live = (f: Omit<LiveMsg, "type" | "agent">): ServerMessage => ({
  type: "live",
  agent: "dev",
  ...f,
});
const patch = (messageId: string, index: number, offset: number, append: string) =>
  live({ texts: [{ messageId, index, offset, append }] });
const liveIn = (s: SessionState, m: ServerMessage) =>
  sessionReducer(s, { type: "frames", messages: [m] });
const said = (seq: number, text: string, messageId?: string, blockIndex?: number) =>
  sessionEvent(seq, {
    type: "assistant_text",
    text,
    ...(messageId === undefined ? {} : { messageId, blockIndex }),
  });
const textsOf = (s: SessionState) =>
  s.live.texts.map((t) => [liveKey(t.messageId, t.index), t.text]);
const progress = (toolUseId: string, toolUses = 1) => ({
  toolUseId,
  description: "Look",
  subagentType: "Explore",
  toolUses,
  tokens: 10,
  durationMs: 100,
});

test("patches grow a block; an overlapping offset replaces from it", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "Hel"));
  expect(textsOf(s)).toEqual([["m1:1", "Hel"]]);
  expect(s.live.texts[0]?.fromReset).toBe(false);
  s = liveIn(s, patch("m1", 1, 3, "lo"));
  expect(textsOf(s)).toEqual([["m1:1", "Hello"]]);
  s = liveIn(s, patch("m1", 1, 4, "o wor"));
  expect(textsOf(s)).toEqual([["m1:1", "Hello wor"]]);
  // Two blocks live at once.
  s = liveIn(s, patch("m1", 2, 0, "Next"));
  expect(textsOf(s)).toEqual([
    ["m1:1", "Hello wor"],
    ["m1:2", "Next"],
  ]);
  expect(s.snapshotWanted).toBe(0);
});

test("a persisted assistant_text removes its block in the same step and adds its key to retired", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "Hello wor"));
  s = sessionReducer(s, frames([said(10, "Hello world", "m1", 1)]));
  expect(s.live.texts).toEqual([]);
  expect(s.retired.has("m1:1")).toBe(true);
  expect(s.ordered.at(-1)?.seq).toBe(10);
  // A row without a key retires nothing.
  const t = sessionReducer(liveIn(loaded(), patch("m2", 0, 0, "x")), frames([said(10, "x")]));
  expect(textsOf(t)).toEqual([["m2:0", "x"]]);
});

test("the persisted row that retires a live block is handed off (it never fades); one without a live block isn't", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "Hello wor"));
  s = sessionReducer(s, frames([said(10, "Hello world", "m1", 1)]));
  expect(s.handedOff.has("t:m1:1")).toBe(true);
  // No live block held that key: it arrived as a row only, and fades like any live row.
  const t = sessionReducer(loaded(), frames([said(10, "Hi", "m2", 1)]));
  expect(t.handedOff.has("t:m2:1")).toBe(false);
});

test("a late frame or a reset entry for a retired key is ignored", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "Hello"));
  s = sessionReducer(s, frames([said(10, "Hello world", "m1", 1)]));
  const late = liveIn(s, patch("m1", 1, 5, " world"));
  expect(late.live.texts).toEqual([]);
  expect(late.snapshotWanted).toBe(0);
  const reset = liveIn(
    s,
    live({
      reset: true,
      texts: [
        { messageId: "m1", index: 1, offset: 0, append: "Hello world" },
        { messageId: "m1", index: 2, offset: 0, append: "More" },
      ],
    }),
  );
  expect(textsOf(reset)).toEqual([["m1:2", "More"]]);
});

test("retired is seeded from loaded rows: a reset holding a block whose row is loaded shows one block", () => {
  const s0 = sessionReducer(initialSessionState, {
    type: "loaded",
    page: {
      events: [said(5, "Hi"), said(6, "Hello world", "m1", 1)],
      hasMore: { before: false, after: false },
    },
    detail: { agent: agentSummary({ turnOpen: true, turnStartedAt: at }), queue: [], lastSeq: 6 },
    mode: "latest",
  });
  expect([...s0.retired]).toEqual(["m1:1"]);
  const s = liveIn(
    s0,
    live({ reset: true, texts: [{ messageId: "m1", index: 1, offset: 0, append: "Hello world" }] }),
  );
  expect(s.live.texts).toEqual([]);
  // The rows hold the block once; live holds nothing.
  expect(s.ordered.filter((e) => e.event.type === "assistant_text")).toHaveLength(2);
});

test("a reset replaces live, marks its blocks fromReset, and catches up", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "old"));
  s = sessionReducer(s, frames([said(10, "a")]));
  expect(s.liveAfter).toBe(9);
  s = liveIn(
    s,
    live({
      reset: true,
      texts: [{ messageId: "m2", index: 0, offset: 0, append: "so far", capped: true }],
      thinking: { tokens: 12 },
      subagents: [progress("tu1")],
    }),
  );
  expect(s.live.texts).toEqual([
    { messageId: "m2", index: 0, text: "so far", capped: true, fromReset: true },
  ]);
  expect(s.live.thinking).toEqual({ tokens: 12 });
  expect(s.live.subagents).toEqual([progress("tu1")]);
  expect(s.liveAfter).toBe(10);
  // A reset with nothing clears everything.
  const empty = liveIn(s, live({ reset: true }));
  expect(empty.live.texts).toEqual([]);
  expect(empty.live.thinking).toBeUndefined();
  expect(empty.live.subagents).toEqual([]);
});

test("a reset's retire list and a patch's retire list remove blocks and retire their keys", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "a"));
  s = liveIn(s, patch("m1", 2, 0, "b"));
  s = liveIn(s, live({ retire: ["m1:1"] }));
  expect(textsOf(s)).toEqual([["m1:2", "b"]]);
  expect(s.retired.has("m1:1")).toBe(true);
  expect(liveIn(s, patch("m1", 1, 0, "again")).live.texts).toHaveLength(1);
});

test("a patch that would take a block past twice the server cap is ignored and asks for one snapshot", () => {
  const max = 2 * 64 * 1024;
  let s = liveIn(loaded(), patch("m1", 1, 0, "a".repeat(max - 1)));
  expect(s.live.texts[0]?.text.length).toBe(max - 1);
  s = liveIn(s, patch("m1", 1, max - 1, "b")); // exactly at the bound: kept
  expect(s.live.texts[0]?.text.length).toBe(max);
  s = liveIn(s, patch("m1", 1, max, "c")); // past it: ignored, a gap
  expect(s.live.texts[0]?.text.length).toBe(max);
  expect(s.snapshotWanted).toBe(1);
  s = liveIn(s, patch("m2", 0, 0, "x".repeat(max + 1))); // a new block too
  expect(s.live.texts.map((t) => t.messageId)).toEqual(["m1"]);
  expect(s.snapshotWanted).toBe(1); // still waiting for the one reset
});

test("an offset gap bumps snapshotWanted once until a reset answers it", () => {
  let s = liveIn(loaded(), patch("m1", 1, 0, "Hel"));
  s = liveIn(s, patch("m1", 1, 5, "xx")); // the block is 3 long: a gap
  expect(textsOf(s)).toEqual([["m1:1", "Hel"]]);
  expect(s.snapshotWanted).toBe(1);
  s = liveIn(s, patch("m1", 1, 7, "yy"));
  s = liveIn(s, patch("m9", 0, 4, "zz")); // an unknown block mid-way is a gap too
  expect(s.snapshotWanted).toBe(1);
  expect(textsOf(s)).toEqual([["m1:1", "Hel"]]);
  s = liveIn(
    s,
    live({ reset: true, texts: [{ messageId: "m1", index: 1, offset: 0, append: "Hello xxyy" }] }),
  );
  s = liveIn(s, patch("m1", 1, 20, "!"));
  expect(s.snapshotWanted).toBe(2);
  // Two gaps folded into one batch still ask once.
  const both = sessionReducer(liveIn(loaded(), patch("m1", 1, 0, "a")), {
    type: "frames",
    messages: [patch("m1", 1, 5, "x"), patch("m1", 1, 9, "y")],
  });
  expect(both.snapshotWanted).toBe(1);
});

test("a live turn_end clears live except subagents, and empties retired", () => {
  let s = loaded({ agent: { turnOpen: true, turnStartedAt: at } });
  s = liveIn(
    s,
    live({
      texts: [{ messageId: "m1", index: 0, offset: 0, append: "orphan" }],
      toolInput: { toolUseId: "tu9", name: "Write", bytes: 10 },
      thinking: { tokens: 3 },
      subagents: [progress("tu1")],
    }),
  );
  s = sessionReducer(s, frames([said(10, "x", "m0", 0)]));
  expect(s.retired.size).toBe(1);
  const subagents = s.live.subagents;
  s = sessionReducer(s, frames([sessionEvent(11, turnEnd())]));
  expect(s.live.texts).toEqual([]);
  expect(s.live.toolInput).toBeUndefined();
  expect(s.live.thinking).toBeUndefined();
  expect(s.live.subagents).toBe(subagents);
  expect(s.retired.size).toBe(0);
  // exited does the same.
  const x = sessionReducer(liveIn(loaded(), patch("m3", 0, 0, "a")), {
    ...frames([
      sessionEvent(10, { type: "exited", code: 1, signal: null, stderrTail: "", expected: false }),
    ]),
  });
  expect(x.live.texts).toEqual([]);
});

test("a persisted tool_call clears the live tool input it matches", () => {
  let s = liveIn(
    loaded(),
    live({ toolInput: { toolUseId: "tu1", name: "Write", bytes: 40, target: "a.ts" } }),
  );
  expect(s.live.toolInput?.target).toBe("a.ts");
  const other = sessionReducer(
    s,
    frames([sessionEvent(10, { type: "tool_call", toolUseId: "tu0", name: "Read", input: {} })]),
  );
  expect(other.live.toolInput?.toolUseId).toBe("tu1");
  s = sessionReducer(
    s,
    frames([sessionEvent(10, { type: "tool_call", toolUseId: "tu1", name: "Write", input: {} })]),
  );
  expect(s.live.toolInput).toBeUndefined();
  // null clears; absent keeps.
  s = liveIn(s, live({ thinking: { tokens: 5 } }));
  expect(liveIn(s, live({ texts: [] })).live.thinking).toEqual({ tokens: 5 });
  expect(liveIn(s, live({ thinking: null })).live.thinking).toBeUndefined();
});

test("texts and subagents keep their identity independently; equal progress entries are reused", () => {
  let s = liveIn(loaded(), live({ subagents: [progress("tu1"), progress("tu2")] }));
  const subs = s.live.subagents;
  s = liveIn(s, patch("m1", 0, 0, "a"));
  expect(s.live.subagents).toBe(subs);
  const texts = s.live.texts;
  s = liveIn(s, live({ subagents: [progress("tu1"), progress("tu2", 2)] }));
  expect(s.live.texts).toBe(texts);
  expect(s.live.subagents).not.toBe(subs);
  expect(s.live.subagents[0]).toBe(subs[0]);
  expect(s.live.subagents[1]).not.toBe(subs[1]);
  // The same list again keeps the array.
  const again = s.live.subagents;
  expect(liveIn(s, live({ subagents: [progress("tu1"), progress("tu2", 2)] })).live.subagents).toBe(
    again,
  );
  // A frame changing nothing keeps the state.
  expect(liveIn(s, live({}))).toBe(s);
});

test("windowed views ignore live frames", () => {
  const s0 = loaded({}, "window");
  expect(s0.windowed).toBe(true);
  expect(liveIn(s0, patch("m1", 0, 0, "a"))).toBe(s0);
  expect(liveIn(s0, live({ reset: true, texts: [] }))).toBe(s0);
});

test("a reload of the same session keeps live; another session starts empty", () => {
  const s = liveIn(loaded(), patch("m1", 0, 0, "a"));
  expect(
    sessionReducer(s, { type: "loaded", page: page([7, 8, 9]), detail, mode: "latest" }).live,
  ).toBe(s.live);
  const other = sessionReducer(s, {
    type: "loaded",
    page: page([1]),
    detail: { ...detail, agent: agentSummary({ slug: "qa" }) },
    mode: "latest",
  });
  expect(other.live.texts).toEqual([]);
});

// I1 §5: a raw send is one node from Sending to the operator_input row.
const rawInput = (cid: string): SessionEvent["event"] => ({
  type: "operator_input",
  text: "/context",
  by: "@or",
  clientMessageId: cid,
  entryId: "e1",
});

test("an operator_input row replaces the raw queue item in one step and is handed off", () => {
  const s = sessionReducer(
    loaded({ queue: [{ ...qItem("q1"), kind: "raw", clientMessageId: "c1" }] }),
    frames([sessionEvent(10, rawInput("c1"))]),
  );
  expect(s.queue).toEqual([]);
  expect(s.handedOff.has("raw:c1")).toBe(true);
});

test("an operator_input row replaces the Sending block and lists it as landed", () => {
  const sending = sessionReducer(loaded(), {
    type: "sending",
    block: { clientMessageId: "c2", body: "/context", urgent: false, raw: true },
  });
  const s = sessionReducer(sending, frames([sessionEvent(10, rawInput("c2"))]));
  expect(s.sending).toEqual([]);
  expect(s.landed.has("c2")).toBe(true);
  expect(s.handedOff.has("raw:c2")).toBe(true);
});

test("an operator_input row of someone else's send hands nothing off", () => {
  const s = sessionReducer(loaded(), frames([sessionEvent(10, rawInput("zz"))]));
  expect(s.handedOff.size).toBe(0);
});
