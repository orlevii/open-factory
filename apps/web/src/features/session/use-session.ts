import {
  type AgentDetail,
  type AgentSummary,
  ApiError,
  type EventsPage,
  type QueueItem,
  type ServerMessage,
  type SessionEvent,
} from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useWs } from "@/lib/ws-context";
import { agentDetailQueryOptions, fetchEvents, fetchMessage } from "./api";
import {
  buildRows,
  deliveryFailedIds,
  interruptedTurnEnds,
  type OpenTurnRows,
  type Row,
  stabilizeOpen,
  stabilizeRows,
  stableSet,
} from "./rows";
import {
  eventsInOrder,
  highestSeq,
  initialSessionState,
  type SessionAction,
  sessionReducer,
} from "./session-state";

const asApiError = (e: unknown) =>
  e instanceof ApiError
    ? e
    : new ApiError(0, "network_error", e instanceof Error ? e.message : String(e));

/** HTTP pages + WS subscription + dedup by seq + queue + status + the deep-link window. */
/** Why `?message=` couldn't jump to the message (UI design §2.5); rendered by the session view so the
 *  recipient's `@slug` can be mono. */
export type MessageNotice = { kind: "rejected"; to: string } | { kind: "not_found" };

/** Derives a value from `input`, letting `compute` reuse the previous committed result (spec §9.3);
 *  recomputed only when `input` changes. The ref is written after commit, never during render, and no
 *  state is set in render, so a frame still costs one render (§9.6). `compute` must be stable. */
function useStabilized<I, V>(input: I, compute: (input: I, prev: V | undefined) => V): V {
  const prev = useRef<V | undefined>(undefined);
  // Reading `prev.current` in render is safe: it only ever holds the last committed value, `compute`
  // is pure, and a StrictMode double render or discarded render recomputes the same result.
  const value = useMemo(() => compute(input, prev.current), [input, compute]);
  useLayoutEffect(() => {
    prev.current = value;
  }, [value]);
  return value;
}
type RowsView = { rows: Row[]; open: OpenTurnRows | undefined };
/** One `buildRows` pass per events change: rows stabilized, `open` mapped onto the stabilized rows. */
const stableRows = (ev: SessionEvent[], prev: RowsView | undefined): RowsView => {
  const built = buildRows(ev);
  const rows = stabilizeRows(prev?.rows ?? [], built.rows);
  const open = stabilizeOpen(prev?.open, built.open, rows);
  return prev && prev.rows === rows && prev.open === open ? prev : { rows, open };
};
const stableFailedIds = (ev: SessionEvent[], prev: ReadonlySet<string> | undefined) =>
  stableSet(prev, deliveryFailedIds(ev));
const stableInterruptedEnds = (ev: SessionEvent[], prev: ReadonlySet<number> | undefined) =>
  stableSet(prev, interruptedTurnEnds(ev));

export function useSession(slug: string, eventSeq?: number, message?: string) {
  const ws = useWs();
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const qc = useQueryClient();
  const [state, dispatchRaw] = useReducer(sessionReducer, initialSessionState);
  // One commit per animation frame (spec §9.6): this agent's frames wait here until the flush.
  const queue = useRef<ServerMessage[]>([]);
  const scheduled = useRef<(() => void) | null>(null); // cancels the pending flush
  const flush = useCallback(() => {
    scheduled.current?.();
    scheduled.current = null;
    if (queue.current.length === 0) return;
    const messages = queue.current;
    queue.current = [];
    dispatchRaw({ type: "frames", messages });
  }, []);
  /** Every local action flushes pending frames first, so order is preserved. */
  const dispatch = useCallback(
    (a: SessionAction) => {
      flush();
      dispatchRaw(a);
    },
    [flush],
  );
  const [missingEvent, setMissingEvent] = useState<number | undefined>();
  const [messageSeq, setMessageSeq] = useState<number | undefined>();
  const [messageNotice, setMessageNotice] = useState<MessageNotice | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [earlierError, setEarlierError] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const lastSeqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(
    async (explicit?: number) => {
      try {
        // A plain visit has nothing to resolve first, so the latest page loads alongside the detail
        // (spec §11); `?event=` and `?message=` need their target before the window can be asked for.
        const plain = explicit === undefined && message === undefined;
        const [detail, latest] = await Promise.all([
          qc.fetchQuery({ ...agentDetailQueryOptions(slug), staleTime: 0 }),
          plain ? fetchEvents(slug) : undefined,
        ]);
        lastSeqRef.current = detail.lastSeq;
        let around = explicit;
        setMessageNotice(undefined);
        if (message !== undefined && around === undefined) {
          // `?message=` resolves to the recipient's event, or says why it can't (UI design §2.5).
          try {
            const m = await fetchMessage(message);
            if (m.state === "delivered" && m.recipientEvent?.agentSlug === slug) {
              around = m.recipientEvent.seq;
              setMessageSeq(around);
            } else if (m.state === "rejected") {
              setMessageNotice({ kind: "rejected", to: m.to });
            }
          } catch (e) {
            if (e instanceof ApiError && e.code === "message_not_found")
              setMessageNotice({ kind: "not_found" });
            // any other failure: the latest page, as for a plain visit
          }
        }
        let page: EventsPage | undefined = latest;
        let mode: "latest" | "window" = "latest";
        setMissingEvent(undefined);
        if (around !== undefined) {
          try {
            page = await fetchEvents(slug, { around });
            mode = "window";
          } catch (e) {
            if (!(e instanceof ApiError && e.code === "event_not_found")) throw e;
            setMissingEvent(around);
          }
        }
        page ??= await fetchEvents(slug);
        dispatch({ type: "loaded", page, detail, mode });
        // Everything held is caught up: nothing loaded fades (U3 §8.3; PR4 adds the live `reset`).
        dispatch({ type: "caught_up" });
        setError(undefined);
        setLoadedAt(Date.now());
      } catch (e) {
        setError(asApiError(e));
      }
    },
    [qc, slug, message, dispatch],
  );

  useEffect(() => {
    void load(eventSeq);
  }, [load, eventSeq]);
  useEffect(
    () =>
      ws.listen((m) => {
        if (!("agent" in m) || m.agent !== slug) return; // other agents never touch this state
        queue.current.push(m);
        if (scheduled.current) return;
        if (document.hidden) {
          const t = setTimeout(flush, 100); // rAF pauses in background tabs
          scheduled.current = () => clearTimeout(t);
        } else {
          const id = requestAnimationFrame(flush);
          scheduled.current = () => cancelAnimationFrame(id);
        }
      }),
    [ws, slug, flush],
  );
  // Unmount or a slug change drops the pending flush and the frames for the old slug.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup runs on every slug change
  useEffect(
    () => () => {
      scheduled.current?.();
      scheduled.current = null;
      queue.current = [];
    },
    [slug],
  );
  // The timer kind is picked when the first frame arrives: a tab hidden before its rAF fires would
  // hold the frames until it is shown again, and one shown again need not wait out the 100ms. Either
  // way, a visibility change commits what is pending. Coming back also moves `liveAfter` in the
  // same commit: rows committed while hidden never got a style pass and must not all fade (U3 §8.3).
  useEffect(() => {
    const onVisibility = () => {
      if (scheduled.current) flush();
      if (!document.hidden) dispatchRaw({ type: "visible" });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [flush]);

  // (Re)subscribe after every load and every socket (re)open. A windowed view only counts new
  // events, so it subscribes from the agent's lastSeq (spec §10), or after the newest seq it has
  // already counted on a reconnect; otherwise from the highest seq held.
  useEffect(() => {
    if (!loadedAt || !ws.openCount) return;
    const s = stateRef.current;
    const afterSeq = s.windowed ? Math.max(lastSeqRef.current, s.maxSeenSeq) : highestSeq(s);
    wsRef.current.send({ type: "subscribe", agent: slug, afterSeq });
    return () => {
      wsRef.current.send({ type: "unsubscribe", agent: slug });
    };
  }, [slug, loadedAt, ws.openCount]);

  useEffect(() => {
    if (state.needsReload) void load(eventSeq); // keeps a deep-link window
  }, [state.needsReload, load, eventSeq]);

  // A load that failed while the server was away (a restart: 502, network) retries itself when the
  // socket is back, keeping what is on screen meanwhile; the shell's reconnect strip covers the wait.
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    const failed = errorRef.current;
    if (ws.openCount && failed && failed.code !== "agent_not_found") void load(eventSeq);
  }, [ws.openCount, load, eventSeq]);

  // Already stable: only an event change produces a new array (status and queue frames keep it).
  const events = eventsInOrder(state);
  // Unchanged rows and equal sets keep their identity, so memoized timeline items skip (spec §9.3).
  const { rows, open } = useStabilized(events, stableRows);
  const failedIds = useStabilized(events, stableFailedIds);
  const interruptedEnds = useStabilized(events, stableInterruptedEnds);

  /** Resolves true when rows were prepended. */
  const loadEarlier = useCallback(async () => {
    const lowest = events[0]?.seq;
    if (!lowest) return false;
    try {
      const page = await fetchEvents(slug, { before: lowest });
      dispatch({ type: "earlier", page });
      setEarlierError(false);
      return page.events.length > 0;
    } catch {
      setEarlierError(true);
      return false;
    }
  }, [events, slug, dispatch]);

  const retry = useCallback(() => load(eventSeq), [load, eventSeq]);

  /** A summary from a terminate or pin response: the view and the cached detail both take it. */
  const setAgent = useCallback(
    (agent: AgentSummary) => {
      dispatch({ type: "agent", agent });
      qc.setQueryData<AgentDetail>(["agent", agent.slug], (d) => (d ? { ...d, agent } : d));
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    [qc, dispatch],
  );

  /** Refetches the summary only (not the events): after a send raced a termination. */
  const refreshAgent = useCallback(
    () =>
      qc.fetchQuery({ ...agentDetailQueryOptions(slug), staleTime: 0 }).then(
        (d) => dispatch({ type: "agent", agent: d.agent }),
        () => {},
      ),
    [qc, slug, dispatch],
  );
  // A status frame says `terminated` but carries no termination fields (who, when, the workspace):
  // fetch them once. A failure leaves the strip without its sentence; the next load fills it.
  const needsTermination =
    state.agent?.status === "terminated" && state.agent.terminatedAt === undefined;
  useEffect(() => {
    if (needsTermination) void refreshAgent();
  }, [needsTermination, refreshAgent]);

  /** While the socket is down no `queue` frame will come, so show the accepted item at once
   *  (UI design §4.4); when connected the frame is authoritative. */
  const onQueued = useCallback(
    (item: QueueItem) => {
      if (wsRef.current.status !== "open") dispatch({ type: "queued", item });
    },
    [dispatch],
  );

  return {
    state,
    rows,
    open,
    failedIds,
    interruptedEnds,
    loadEarlier,
    earlierError,
    retry,
    onQueued,
    setAgent,
    refreshAgent,
    missingEvent,
    messageSeq,
    messageNotice,
    error,
  };
}
