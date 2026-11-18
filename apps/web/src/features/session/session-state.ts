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
  queue: [],
  agent: undefined,
  needsReload: false,
};

export type SessionAction =
  | { type: "loaded"; page: EventsPage; detail: AgentDetail; mode: "latest" | "window" }
  | { type: "earlier"; page: EventsPage }
  | { type: "frame"; message: ServerMessage }
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
        queue: a.detail.queue,
        agent: a.detail.agent,
      };
    case "earlier":
      return {
        ...s,
        events: withEvents(s.events, a.page.events),
        hasMoreBefore: a.page.hasMore.before,
      };
    case "frame": {
      const m = a.message;
      if (!("agent" in m) || m.agent !== s.slug) return s;
      if (m.type === "session_event") {
        if (s.events.has(m.event.seq)) return s;
        if (s.windowed) return { ...s, newWhileAway: s.newWhileAway + 1 };
        return { ...s, events: withEvents(s.events, [m.event]) };
      }
      if (m.type === "queue") return { ...s, queue: m.items };
      if (m.type === "agent_status" && s.agent) {
        const { type: _t, agent: _a, ...rest } = m;
        return { ...s, agent: { ...s.agent, ...rest, lastError: m.lastError } };
      }
      if (m.type === "resync") return { ...s, needsReload: true };
      return s;
    }
  }
}

export const eventsInOrder = (s: SessionState) =>
  [...s.events.values()].sort((a, b) => a.seq - b.seq);
export const highestSeq = (s: SessionState) => Math.max(0, ...s.events.keys());
