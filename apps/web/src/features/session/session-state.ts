import type {
  AgentDetail,
  AgentSummary,
  EventsPage,
  QueueItem,
  ServerMessage,
  SessionEvent,
} from "@open-factory/shared";
import { speechCount } from "./rows";

/** A held message you cancelled (U3 §6.4): the line "Message cancelled. Undo" shows at `index` among
 *  the queue items until your next send. */
export interface CancelledEntry {
  item: QueueItem;
  /** Its place among the visible queue items when it was cancelled. */
  index: number;
  /** A failed cancel (`rolledBack`) or a failed restore: why, shown in place of Undo. */
  error?: string;
  /** Cancel moved the text into the empty composer box. */
  inBox?: boolean;
  /** The cancel failed: the item shows again, with `error` under it. */
  rolledBack?: boolean;
  /** Undo succeeded: the line goes when the queue frame brings the item back (one step). */
  restored?: boolean;
  /** Your next send cleared the line; the entry only keeps a stale frame from showing the item. */
  dismissed?: boolean;
}

/** An optimistic send (U3 §13.2): drawn in the queue area as "Sending" until the server echoes its
 *  `clientMessageId` (the 202's item, a `queue` frame or the delivered `message_in`). */
export interface SendingBlock {
  clientMessageId: string;
  body: string;
  urgent: boolean;
}

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
  /** Optimistic Cancel overlay (U3 §6.4), by message id: hides the item, shows the outcome line. */
  cancelled: ReadonlyMap<string, CancelledEntry>;
  /** Sends in flight, oldest first (U3 §13.2). */
  sending: readonly SendingBlock[];
  /** Sends whose POST aborted after 15s: a late echo of one moves it to `landed`. */
  awaiting: ReadonlySet<string>;
  /** `clientMessageId`s of this tab's sends the server has echoed: the composer reads it to treat an
   *  aborted send as sent and to clear its unchanged text (never to send it twice). */
  landed: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();
export const NO_CANCELLED: ReadonlyMap<string, CancelledEntry> = new Map();
const NO_SENDING: readonly SendingBlock[] = [];
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
  cancelled: NO_CANCELLED,
  sending: NO_SENDING,
  awaiting: NONE,
  landed: NONE,
};

export type SessionAction =
  | { type: "loaded"; page: EventsPage; detail: AgentDetail; mode: "latest" | "window" }
  | { type: "earlier"; page: EventsPage }
  | { type: "frame"; message: ServerMessage }
  /** The frames of one animation frame, folded in order (one commit per frame). */
  | { type: "frames"; messages: ServerMessage[] }
  /** A 202's queue item: it replaces its "Sending" block; with no block it is inserted only while the
   *  socket is down (`live` false), and the next `queue` frame replaces it. */
  | { type: "queued"; item: QueueItem; live?: boolean }
  /** U3 §13.2: Enter added an optimistic block. */
  | { type: "sending"; block: SendingBlock }
  /** The POST failed (the block goes); `unconfirmed` when it aborted after 15s and may still land. */
  | { type: "send_failed"; clientMessageId: string; unconfirmed?: boolean | undefined }
  /** A fresh summary from a response or a refetch (S7: terminate, pin, the termination fields). */
  | { type: "agent"; agent: AgentSummary }
  /** Everything held so far is caught up (after a load; PR4 adds the subscribe's `reset` frame). */
  | { type: "caught_up" }
  /** The tab became visible: rows committed while hidden never got a style pass, so none fades. */
  | { type: "visible" }
  /** U3 §6.4: Cancel, optimistic (one commit); `inBox` when its text moved into the empty box. */
  | { type: "cancel"; id: string; inBox?: boolean }
  /** The DELETE failed: the item comes back with the reason. */
  | { type: "cancel_failed"; id: string; error: string }
  /** Undo's POST succeeded: the line goes in the step that shows the item again. */
  | { type: "restored"; id: string }
  /** Undo's POST failed: the line stays, says why, and loses Undo. */
  | { type: "restore_failed"; id: string; error: string }
  /** Your next send: the cancelled lines go. */
  | { type: "clear_cancelled" }
  | { type: "reset" };

const bySeq = (a: SessionEvent, b: SessionEvent) => a.seq - b.seq;

/** An item hidden behind its cancel (until a rollback or the restored frame). */
const hides = (c: CancelledEntry | undefined) => c !== undefined && !c.rolledBack;

export type QueueViewEntry =
  | { kind: "item"; item: QueueItem; error?: string }
  | { kind: "cancelled"; id: string; entry: CancelledEntry };

/** The queue as it renders: items without the ones you cancelled, each cancelled line at its place. A
 *  cancel that failed shows its item again with the reason; if the item already left the queue (it was
 *  delivered first), the reason keeps a line of its own. */
export function queueView(
  queue: QueueItem[],
  cancelled: ReadonlyMap<string, CancelledEntry>,
): QueueViewEntry[] {
  const items: QueueViewEntry[] = [];
  for (const item of queue) {
    const c = cancelled.get(item.id);
    if (hides(c)) continue;
    items.push(c?.error ? { kind: "item", item, error: c.error } : { kind: "item", item });
  }
  if (cancelled.size === 0) return items;
  const listed = new Set(queue.map((q) => q.id));
  const lines = [...cancelled]
    .filter(([id, c]) => (c.rolledBack ? c.error !== undefined && !listed.has(id) : !c.dismissed))
    .sort(([, a], [, b]) => a.index - b.index);
  const out: QueueViewEntry[] = [];
  let l = 0;
  for (const [i, entry] of items.entries()) {
    for (; l < lines.length && (lines[l]?.[1].index ?? 0) <= i; l++) {
      const [id, c] = lines[l] as [string, CancelledEntry];
      out.push({ kind: "cancelled", id, entry: c });
    }
    out.push(entry);
  }
  for (; l < lines.length; l++) {
    const [id, c] = lines[l] as [string, CancelledEntry];
    out.push({ kind: "cancelled", id, entry: c });
  }
  return out;
}

/** `cancelled` after a queue change: a restored item that is back, or a dismissed one the server no
 *  longer lists, needs no entry. */
function pruneCancelled(
  cancelled: ReadonlyMap<string, CancelledEntry>,
  queue: QueueItem[],
): ReadonlyMap<string, CancelledEntry> {
  if (cancelled.size === 0) return cancelled;
  const listed = new Set(queue.map((q) => q.id));
  let next: Map<string, CancelledEntry> | undefined;
  for (const [id, c] of cancelled) {
    if ((c.restored && listed.has(id)) || (c.dismissed && !listed.has(id))) {
      next ??= new Map(cancelled);
      next.delete(id);
    }
  }
  return next ?? cancelled;
}

const withEntry = (
  s: SessionState,
  id: string,
  update: (c: CancelledEntry) => CancelledEntry | undefined,
): SessionState => {
  const c = s.cancelled.get(id);
  if (!c) return s;
  const next = new Map(s.cancelled);
  const u = update(c);
  if (u) next.set(id, u);
  else next.delete(id);
  return { ...s, cancelled: next };
};

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

/** The server echoed these `clientMessageId`s: their "Sending" blocks go and they count as landed (an
 *  aborted send's too). The same state when none is one of ours. */
function withEchoes(s: SessionState, ids: Iterable<string | undefined>): SessionState {
  if (s.sending.length === 0 && s.awaiting.size === 0) return s;
  let landed: Set<string> | undefined;
  let awaiting: Set<string> | undefined;
  for (const id of ids) {
    if (id === undefined) continue;
    const ours = s.awaiting.has(id) || s.sending.some((b) => b.clientMessageId === id);
    if (!ours || (landed ?? s.landed).has(id)) continue;
    landed ??= new Set(s.landed);
    landed.add(id);
    if (s.awaiting.has(id)) {
      awaiting ??= new Set(s.awaiting);
      awaiting.delete(id);
    }
  }
  if (!landed) return s;
  const sending = s.sending.filter((b) => !landed.has(b.clientMessageId));
  return {
    ...s,
    landed,
    ...(awaiting ? { awaiting } : {}),
    sending: sending.length === s.sending.length ? s.sending : sending,
  };
}

const echoedBy = (items: QueueItem[]) => items.map((q) => q.clientMessageId);

/** What newly appended live events do besides becoming rows (U3 §8.3, §5.3), in the same step: a
 *  `message_in` takes the queue items it delivered off the queue and its rows are handed off; a
 *  `turn_end` closes the turn, so the activity line goes as its footer arrives. Only events above
 *  `liveAfter` count: never loaded, earlier, resync or windowed pages. */
function applyLive(s: SessionState, fresh: SessionEvent[]): SessionState {
  let next = s;
  for (const se of fresh) {
    if (se.seq <= s.liveAfter) continue;
    const e = se.event;
    if (e.type === "message_in" && (next.queue.length > 0 || next.sending.length > 0)) {
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
        const block =
          m.clientMessageId !== undefined &&
          next.sending.some((b) => b.clientMessageId === m.clientMessageId);
        if (kept.length === queue.length && !block) continue;
        queue = kept;
        handedOff ??= new Set(next.handedOff);
        handedOff.add(`${se.seq}:${i}`);
      }
      if (handedOff) next = { ...next, queue, handedOff };
      next = withEchoes(
        next,
        e.messages.map((m) => m.clientMessageId),
      );
    } else if (e.type === "message_in") {
      next = withEchoes(
        next,
        e.messages.map((m) => m.clientMessageId),
      );
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
      return loadedEchoes(
        withAgent(
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
            // A reload of the same session (a resync) keeps your cancelled lines; leaving drops them.
            cancelled:
              s.slug === a.detail.agent.slug
                ? pruneCancelled(s.cancelled, a.detail.queue)
                : NO_CANCELLED,
            // ...and its sends in flight, which the reloaded queue may already hold.
            ...(s.slug === a.detail.agent.slug
              ? { sending: s.sending, awaiting: s.awaiting, landed: s.landed }
              : {}),
            liveAfter: a.page.events.reduce((m, e) => Math.max(m, e.seq), 0),
          },
          a.detail.agent,
        ),
        a,
      );
    case "earlier":
      return {
        ...s,
        ...withEvents(s, a.page.events),
        hasMoreBefore: a.page.hasMore.before,
      };
    case "queued": {
      const cid = a.item.clientMessageId;
      const handsOff = cid !== undefined && s.sending.some((b) => b.clientMessageId === cid);
      if (!handsOff && a.live) return s; // the frames are authoritative while connected
      const next = withEchoes(s, [cid]);
      // A retry's 202 answers with the original, even one you cancelled since: it stays cancelled.
      if (next.queue.some((q) => q.id === a.item.id) || hides(next.cancelled.get(a.item.id)))
        return next;
      return { ...next, queue: [...next.queue, a.item] };
    }
    case "sending": {
      const id = a.block.clientMessageId;
      if (s.sending.some((b) => b.clientMessageId === id)) return s;
      let awaiting = s.awaiting;
      if (awaiting.has(id)) {
        const next = new Set(awaiting);
        next.delete(id);
        awaiting = next;
      }
      return { ...s, sending: [...s.sending, a.block], awaiting };
    }
    case "send_failed": {
      const id = a.clientMessageId;
      const sending = s.sending.filter((b) => b.clientMessageId !== id);
      const wait = a.unconfirmed === true && !s.landed.has(id) && !s.awaiting.has(id);
      if (sending.length === s.sending.length && !wait) return s;
      return {
        ...s,
        sending: sending.length === s.sending.length ? s.sending : sending,
        ...(wait ? { awaiting: new Set(s.awaiting).add(id) } : {}),
      };
    }
    case "cancel": {
      if (hides(s.cancelled.get(a.id))) return s;
      const visible = queueView(s.queue, s.cancelled).flatMap((v) =>
        v.kind === "item" ? [v.item] : [],
      );
      const index = visible.findIndex((q) => q.id === a.id);
      const item = visible[index];
      if (!item) return s;
      const cancelled = new Map(s.cancelled);
      cancelled.set(a.id, { item, index, ...(a.inBox ? { inBox: true } : {}) });
      return { ...s, cancelled };
    }
    case "cancel_failed":
      return withEntry(s, a.id, (c) => ({ ...c, rolledBack: true, error: a.error }));
    case "restored":
      return withEntry(s, a.id, (c) =>
        s.queue.some((q) => q.id === a.id) ? undefined : { ...c, restored: true },
      );
    case "restore_failed":
      return withEntry(s, a.id, (c) => ({ ...c, error: a.error }));
    case "clear_cancelled": {
      if (s.cancelled.size === 0) return s;
      const cancelled = new Map<string, CancelledEntry>();
      // A cancel the server hasn't confirmed yet keeps hiding its item; everything else goes.
      for (const [id, c] of s.cancelled)
        if (!c.rolledBack && !c.restored && s.queue.some((q) => q.id === id))
          cancelled.set(id, { ...c, dismissed: true });
      return { ...s, cancelled: cancelled.size ? cancelled : NO_CANCELLED };
    }
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
      if (m.type === "queue")
        return withEchoes(
          { ...s, queue: m.items, cancelled: pruneCancelled(s.cancelled, m.items) },
          echoedBy(m.items),
        );
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

/** A reload of the same session: its queue and page may echo sends still in flight. */
function loadedEchoes(
  s: SessionState,
  a: Extract<SessionAction, { type: "loaded" }>,
): SessionState {
  if (s.sending.length === 0 && s.awaiting.size === 0) return s;
  const ids: (string | undefined)[] = echoedBy(a.detail.queue);
  for (const e of a.page.events)
    if (e.event.type === "message_in")
      for (const m of e.event.messages) ids.push(m.clientMessageId);
  return withEchoes(s, ids);
}

export const eventsInOrder = (s: SessionState) => s.ordered;
/** A plain loop: spreading a long session's keys into `Math.max` overflows the argument limit. */
export const highestSeq = (s: SessionState) => {
  let max = 0;
  for (const seq of s.events.keys()) if (seq > max) max = seq;
  return max;
};
