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
  hasMoreBefore: boolean;
  /** true while showing an older window (deep link): live events are counted, not appended */
  windowed: boolean;
  newWhileAway: number;
  /** Highest seq already accounted for while windowed (starts at the detail's lastSeq), so a
   *  reconnect's replay is not counted twice and the resubscribe starts after it. */
  maxSeenSeq: number;
  queue: QueueItem[];
  agent: AgentSummary | undefined;
  needsReload: boolean;
}

export const initialSessionState: SessionState = {
  slug: undefined,
  events: new Map(),
  hasMoreBefore: false,
  windowed: false,
  newWhileAway: 0,
  maxSeenSeq: 0,
  queue: [],
  agent: undefined,
  needsReload: false,
};

export type SessionAction =
  | { type: "loaded"; page: EventsPage; detail: AgentDetail; mode: "latest" | "window" }
  | { type: "earlier"; page: EventsPage }
  | { type: "frame"; message: ServerMessage }
  /** A 202 queue item inserted locally while the socket is down; the next `queue` frame replaces it. */
  | { type: "queued"; item: QueueItem }
  /** A fresh summary from a response or a refetch (S7: terminate, pin, the termination fields). */
  | { type: "agent"; agent: AgentSummary }
  | { type: "reset" };

const withEvents = (map: Map<number, SessionEvent>, evs: SessionEvent[]) => {
  const next = new Map(map);
  for (const e of evs) next.set(e.seq, e);
  return next;
};

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "reset":
      return initialSessionState;
    case "loaded":
      return {
        ...initialSessionState,
        slug: a.detail.agent.slug,
        events: withEvents(new Map(), a.page.events),
        hasMoreBefore: a.page.hasMore.before,
        windowed: a.mode === "window" && a.page.hasMore.after,
        maxSeenSeq: a.detail.lastSeq,
        queue: a.detail.queue,
        agent: a.detail.agent,
      };
    case "earlier":
      return {
        ...s,
        events: withEvents(s.events, a.page.events),
        hasMoreBefore: a.page.hasMore.before,
      };
    case "queued":
      if (s.queue.some((q) => q.id === a.item.id)) return s;
      return { ...s, queue: [...s.queue, a.item] };
    case "agent":
      return s.agent && a.agent.slug === s.slug ? { ...s, agent: a.agent } : s;
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
        return { ...s, events: withEvents(s.events, [m.event]) };
      }
      if (m.type === "queue") return { ...s, queue: m.items };
      if (m.type === "agent_status" && s.agent) {
        const { type: _t, agent: _a, ...rest } = m;
        // `lastError` is set explicitly so a frame without it clears the previous one (absent means cleared).
        return { ...s, agent: { ...s.agent, ...rest, lastError: m.lastError } };
      }
      if (m.type === "resync") return { ...s, needsReload: true };
      return s;
    }
  }
}

export const eventsInOrder = (s: SessionState) =>
  [...s.events.values()].sort((a, b) => a.seq - b.seq);
/** A plain loop: spreading a long session's keys into `Math.max` overflows the argument limit. */
export const highestSeq = (s: SessionState) => {
  let max = 0;
  for (const seq of s.events.keys()) if (seq > max) max = seq;
  return max;
};
