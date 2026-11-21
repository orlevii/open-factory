import type {
  AgentDetail,
  AgentSummary,
  EventsPage,
  QueueItem,
  ServerMessage,
  SessionEvent,
} from "@open-factory/shared";

export interface SessionState {
  slug: string | undefined;
  events: Map<number, SessionEvent>;
  /** `events` by seq; a new array only when the events change, appended in the live case. */
  ordered: SessionEvent[];
  hasMoreBefore: boolean;
  /** true while showing an older window (deep link): live events are counted, not appended */
  windowed: boolean;
  newWhileAway: number;
  /** Highest seq already accounted for while windowed (starts at the detail's lastSeq), so a
   *  reconnect's replay is not counted twice and the resubscribe starts after it. */
  maxSeenSeq: number;
  queue: QueueItem[];
  agent: AgentSummary | undefined;
  /** Bumped on every `agent.turnOpen` change the reducer applies, so a consumer that resets on a
   *  turn edge still sees a close and a reopen that were folded into one commit (spec §9.6). */
  turnEpoch: number;
  needsReload: boolean;
}

export const initialSessionState: SessionState = {
  slug: undefined,
  events: new Map(),
  ordered: [],
  hasMoreBefore: false,
  windowed: false,
  newWhileAway: 0,
  maxSeenSeq: 0,
  queue: [],
  agent: undefined,
  turnEpoch: 0,
  needsReload: false,
};

export type SessionAction =
  | { type: "loaded"; page: EventsPage; detail: AgentDetail; mode: "latest" | "window" }
  | { type: "earlier"; page: EventsPage }
  | { type: "frame"; message: ServerMessage }
  /** The frames of one animation frame, folded in order (one commit per frame). */
  | { type: "frames"; messages: ServerMessage[] }
  /** A 202 queue item inserted locally while the socket is down; the next `queue` frame replaces it. */
  | { type: "queued"; item: QueueItem }
  /** A fresh summary from a response or a refetch (S7: terminate, pin, the termination fields). */
  | { type: "agent"; agent: AgentSummary }
  | { type: "reset" };

const bySeq = (a: SessionEvent, b: SessionEvent) => a.seq - b.seq;

/** Adds events; the ordered array is appended when every new seq is above the current max (the live
 *  case), else sorted once. A seq repeated within one batch (a reconnect replay) is inserted once. */
function withEvents(
  s: Pick<SessionState, "events" | "ordered">,
  evs: SessionEvent[],
): Pick<SessionState, "events" | "ordered"> {
  let events: Map<number, SessionEvent> | undefined;
  const fresh: SessionEvent[] = [];
  for (const e of evs) {
    if ((events ?? s.events).has(e.seq)) continue; // already held, or earlier in this batch
    events ??= new Map(s.events);
    events.set(e.seq, e);
    fresh.push(e);
  }
  if (!events) return { events: s.events, ordered: s.ordered };
  const max = s.ordered.at(-1)?.seq ?? 0;
  const sortedFresh = fresh.length > 1 ? fresh.sort(bySeq) : fresh;
  const ordered =
    (sortedFresh[0]?.seq ?? 0) > max
      ? s.ordered.concat(sortedFresh)
      : [...events.values()].sort(bySeq);
  return { events, ordered };
}

/** The state with `agent` replaced, counting a `turnOpen` change in `turnEpoch`. */
const withAgent = (s: SessionState, agent: AgentSummary | undefined): SessionState => ({
  ...s,
  agent,
  turnEpoch: s.turnEpoch + (s.agent?.turnOpen === agent?.turnOpen ? 0 : 1),
});

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "reset":
      return initialSessionState;
    case "loaded":
      return withAgent(
        {
          ...initialSessionState,
          slug: a.detail.agent.slug,
          ...withEvents(initialSessionState, a.page.events),
          hasMoreBefore: a.page.hasMore.before,
          windowed: a.mode === "window" && a.page.hasMore.after,
          maxSeenSeq: a.detail.lastSeq,
          queue: a.detail.queue,
          // the epoch carries across loads, so a reload never makes it repeat a value
          agent: s.agent,
          turnEpoch: s.turnEpoch,
        },
        a.detail.agent,
      );
    case "earlier":
      return {
        ...s,
        ...withEvents(s, a.page.events),
        hasMoreBefore: a.page.hasMore.before,
      };
    case "queued":
      if (s.queue.some((q) => q.id === a.item.id)) return s;
      return { ...s, queue: [...s.queue, a.item] };
    case "agent":
      return s.agent && a.agent.slug === s.slug ? withAgent(s, a.agent) : s;
    case "frame": {
      const m = a.message;
      if (!("agent" in m) || m.agent !== s.slug) return s;
      if (m.type === "session_event") {
        // Gaps are the server's job: on a missed range it sends `resync`, so no gap detection here.
        if (s.events.has(m.event.seq)) return s;
        if (s.windowed) {
          if (m.event.seq <= s.maxSeenSeq) return s;
          return { ...s, newWhileAway: s.newWhileAway + 1, maxSeenSeq: m.event.seq };
        }
        return { ...s, ...withEvents(s, [m.event]) };
      }
      if (m.type === "queue") return { ...s, queue: m.items };
      if (m.type === "agent_status" && s.agent) {
        const { type: _t, agent: _a, ...rest } = m;
        // `lastError` is set explicitly so a frame without it clears the previous one (absent means cleared).
        return withAgent(s, { ...s.agent, ...rest, lastError: m.lastError });
      }
      if (m.type === "resync") return { ...s, needsReload: true };
      return s;
    }
    case "frames": {
      // Consecutive live session_events become one withEvents call (one map copy); everything
      // else goes through the single-frame logic above, in order.
      let next = s;
      let pending: SessionEvent[] = [];
      const drain = () => {
        if (pending.length === 0) return;
        const added = withEvents(next, pending);
        pending = [];
        // A batch of already-held events (a reconnect replay) keeps the state, so React bails out.
        if (added.events !== next.events) next = { ...next, ...added };
      };
      for (const m of a.messages) {
        if (m.type === "session_event" && m.agent === next.slug && !next.windowed) {
          pending.push(m.event);
          continue;
        }
        drain();
        next = sessionReducer(next, { type: "frame", message: m });
      }
      drain();
      return next;
    }
  }
}

export const eventsInOrder = (s: SessionState) => s.ordered;
/** A plain loop: spreading a long session's keys into `Math.max` overflows the argument limit. */
export const highestSeq = (s: SessionState) => {
  let max = 0;
  for (const seq of s.events.keys()) if (seq > max) max = seq;
  return max;
};
