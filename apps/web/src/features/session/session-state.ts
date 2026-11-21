import type {
  AgentDetail,
  AgentSummary,
  EventsPage,
  QueueItem,
  ServerMessage,
  SessionEvent,
} from "@open-factory/shared";
import { speechCount } from "./rows";

export interface SessionState {
  slug: string | undefined;
  events: Map<number, SessionEvent>;
  /** `events` by seq; a new array only when the events change, appended in the live case. */
  ordered: SessionEvent[];
  hasMoreBefore: boolean;
  /** true while showing an older window (deep link): live events are counted, not appended */
  windowed: boolean;
  newWhileAway: number;
  /** The speech among `newWhileAway` (messages, agent text, sends): the Jump pill's count (U3 §8.2). */
  newSpeech: number;
  /** Highest seq already accounted for while windowed (starts at the detail's lastSeq), so a
   *  reconnect's replay is not counted twice and the resubscribe starts after it. */
  maxSeenSeq: number;
  queue: QueueItem[];
  agent: AgentSummary | undefined;
  /** Bumped on every `agent.turnOpen` change the reducer applies, so a consumer that resets on a
   *  turn edge still sees a close and a reopen that were folded into one commit (spec §9.6). */
  turnEpoch: number;
  needsReload: boolean;
  /** Row keys that replace something that was on screen (a queue item a `message_in` delivered):
   *  they never fade (U3 §8.3). */
  handedOff: ReadonlySet<string>;
  /** Rows above this seq arrived by a live frame and fade in; moved on load, on catching up, when the
   *  tab comes back and by a frames batch that appends more than 10 events (U3 §8.3). */
  liveAfter: number;
}

const NONE: ReadonlySet<string> = new Set();
/** A frames batch appending more events than this counts as a load: nothing in it fades. */
const BULK = 10;

export const initialSessionState: SessionState = {
  slug: undefined,
  events: new Map(),
  ordered: [],
  hasMoreBefore: false,
  windowed: false,
  newWhileAway: 0,
  newSpeech: 0,
  maxSeenSeq: 0,
  queue: [],
  agent: undefined,
  turnEpoch: 0,
  needsReload: false,
  handedOff: NONE,
  liveAfter: 0,
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
  /** Everything held so far is caught up (after a load; PR4 adds the subscribe's `reset` frame). */
  | { type: "caught_up" }
  /** The tab became visible: rows committed while hidden never got a style pass, so none fades. */
  | { type: "visible" }
  | { type: "reset" };

const bySeq = (a: SessionEvent, b: SessionEvent) => a.seq - b.seq;

/** Adds events; the ordered array is appended when every new seq is above the current max (the live
 *  case), else sorted once. A seq repeated within one batch (a reconnect replay) is inserted once. */
function withEvents(
  s: Pick<SessionState, "events" | "ordered">,
  evs: SessionEvent[],
): Pick<SessionState, "events" | "ordered"> {
  return withFresh(s, evs).added;
}

/** `withEvents`, also returning the events that were new. */
function withFresh(
  s: Pick<SessionState, "events" | "ordered">,
  evs: SessionEvent[],
): { added: Pick<SessionState, "events" | "ordered">; fresh: SessionEvent[] } {
  let events: Map<number, SessionEvent> | undefined;
  const fresh: SessionEvent[] = [];
  for (const e of evs) {
    if ((events ?? s.events).has(e.seq)) continue; // already held, or earlier in this batch
    events ??= new Map(s.events);
    events.set(e.seq, e);
    fresh.push(e);
  }
  if (!events) return { added: { events: s.events, ordered: s.ordered }, fresh };
  const max = s.ordered.at(-1)?.seq ?? 0;
  const sortedFresh = fresh.length > 1 ? fresh.sort(bySeq) : fresh;
  const ordered =
    (sortedFresh[0]?.seq ?? 0) > max
      ? s.ordered.concat(sortedFresh)
      : [...events.values()].sort(bySeq);
  return { added: { events, ordered }, fresh: sortedFresh };
}

const topSeq = (s: Pick<SessionState, "ordered">) => s.ordered.at(-1)?.seq ?? 0;

/** What newly appended live events do besides becoming rows (U3 §8.3, §5.3), in the same step: a
 *  `message_in` takes the queue items it delivered off the queue and its rows are handed off; a
 *  `turn_end` closes the turn, so the activity line goes as its footer arrives. Only events above
 *  `liveAfter` count: never loaded, earlier, resync or windowed pages. */
function applyLive(s: SessionState, fresh: SessionEvent[]): SessionState {
  let next = s;
  for (const se of fresh) {
    if (se.seq <= s.liveAfter) continue;
    const e = se.event;
    if (e.type === "message_in" && next.queue.length > 0) {
      let handedOff: Set<string> | undefined;
      let queue = next.queue;
      for (const [i, m] of e.messages.entries()) {
        const ids = new Set(m.ids ?? [m.id]);
        ids.add(m.id);
        const kept = queue.filter(
          (q) =>
            !ids.has(q.id) &&
            !(m.clientMessageId !== undefined && q.clientMessageId === m.clientMessageId),
        );
        if (kept.length === queue.length) continue;
        queue = kept;
        handedOff ??= new Set(next.handedOff);
        handedOff.add(`${se.seq}:${i}`);
      }
      if (handedOff) next = { ...next, queue, handedOff };
    } else if (e.type === "turn_end" && next.agent?.turnOpen) {
      next = withAgent(next, { ...next.agent, turnOpen: false, turnStartedAt: undefined });
    }
  }
  return next;
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
          liveAfter: a.page.events.reduce((m, e) => Math.max(m, e.seq), 0),
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
    case "caught_up":
    case "visible": {
      const top = topSeq(s);
      return top > s.liveAfter ? { ...s, liveAfter: top } : s;
    }
    case "frame": {
      const m = a.message;
      if (!("agent" in m) || m.agent !== s.slug) return s;
      if (m.type === "session_event") {
        // Gaps are the server's job: on a missed range it sends `resync`, so no gap detection here.
        if (s.events.has(m.event.seq)) return s;
        if (s.windowed) {
          if (m.event.seq <= s.maxSeenSeq) return s;
          return {
            ...s,
            newWhileAway: s.newWhileAway + 1,
            newSpeech: s.newSpeech + speechCount(m.event.event),
            maxSeenSeq: m.event.seq,
          };
        }
        const { added, fresh } = withFresh(s, [m.event]);
        return applyLive({ ...s, ...added }, fresh);
      }
      if (m.type === "queue") return { ...s, queue: m.items };
      if (m.type === "agent_status" && s.agent) {
        const { type: _t, agent: _a, ...rest } = m;
        // Fields a frame may leave out are set explicitly, so a frame without one clears it (absent
        // means cleared): a spread would keep a stale turn start or compaction.
        return withAgent(s, {
          ...s.agent,
          ...rest,
          lastError: m.lastError,
          turnStartedAt: m.turnStartedAt,
          compacting: m.compacting,
        });
      }
      if (m.type === "resync") return { ...s, needsReload: true };
      return s;
    }
    case "frames": {
      // Consecutive live session_events become one withEvents call (one map copy); everything
      // else goes through the single-frame logic above, in order.
      let next = s;
      let pending: SessionEvent[] = [];
      let appended = 0;
      const drain = () => {
        if (pending.length === 0) return;
        const { added, fresh } = withFresh(next, pending);
        pending = [];
        // A batch of already-held events (a reconnect replay) keeps the state, so React bails out.
        if (added.events !== next.events) {
          appended += fresh.length;
          next = applyLive({ ...next, ...added }, fresh);
        }
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
      // A batch this large reads as a load: nothing in it fades.
      if (appended > BULK) next = { ...next, liveAfter: Math.max(next.liveAfter, topSeq(next)) };
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
