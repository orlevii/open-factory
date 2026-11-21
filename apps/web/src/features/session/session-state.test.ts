import type { AgentDetail, EventsPage, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { agentSummary } from "@/test/session-fixtures";
import { eventsInOrder, highestSeq, initialSessionState, sessionReducer } from "./session-state";

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
