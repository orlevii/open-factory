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
import {
  agentDetailQueryOptions,
  cancelQueued,
  fetchEvents,
  fetchMessage,
  restoreQueued,
} from "./api";
import { NETWORK_ERROR } from "./composer";
import { runDisplayPasses } from "./display-passes";
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
  editedFields,
  eventsInOrder,
  highestSeq,
  initialSessionState,
  type SendingBlock,
  type SessionAction,
  sameEdited,
  sessionReducer,
} from "./session-state";

const asApiError = (e: unknown) =>
  e instanceof ApiError
    ? e
    : new ApiError(0, "network_error", e instanceof Error ? e.message : String(e));

const failureText = (e: unknown) => (e instanceof ApiError ? e.message : NETWORK_ERROR);

/** HTTP pages + WS subscription + dedup by seq + queue + status + the deep-link window. */
/** Why `?message=` couldn't jump to the message (UI design §2.5); rendered by the session view so the
 *  recipient's `@slug` can be mono. */
export type MessageNotice =
  | { kind: "rejected"; to: string }
  | { kind: "cancelled" }
  | { kind: "not_found" };

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
type RawView = { rawRows: Row[]; open: OpenTurnRows | undefined; textHead: boolean };
/** Steps 1-2 of the rows pipeline (U3 §7.7), once per events change: `buildRows`, then the raw rows
 *  stabilized against the previous raw rows (`prevRaw`), and `open` mapped onto them. */
const stableRaw = (ev: SessionEvent[], prev: RawView | undefined): RawView => {
  const built = buildRows(ev);
  const rawRows = stabilizeRows(prev?.rawRows ?? [], built.rows);
  const open = stabilizeOpen(prev?.open, built.open, rawRows);
  const { textHead } = built;
  return prev && prev.rawRows === rawRows && prev.open === open && prev.textHead === textHead
    ? prev
    : { rawRows, open, textHead };
};
/** Steps 3-4: the display passes over the raw rows, then stabilized against the previous final rows
 *  (`prevFinal`, kept apart from `prevRaw`), so a grown group is a new object holding the same
 *  children and every row a pass leaves alone keeps its identity. */
const stableFinal = (raw: Row[], prev: Row[] | undefined): Row[] =>
  stabilizeRows(prev ?? [], runDisplayPasses(raw));
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
            // To this agent: its receiving event. From it (a reply to a human has no recipient event): its sending call.
            const at =
              m.recipientEvent?.agentSlug === slug
                ? m.recipientEvent
                : m.senderEvent?.agentSlug === slug
                  ? m.senderEvent
                  : undefined;
            if (m.state === "delivered" && at) {
              around = at.seq;
              setMessageSeq(around);
            } else if (m.state === "rejected") {
              // The lookup names the recipient as `@slug`; the notice holds the bare slug.
              setMessageNotice({ kind: "rejected", to: m.to.replace(/^@/, "") });
            } else if (m.state === "cancelled") {
              setMessageNotice({ kind: "cancelled" }); // U3 §6.4
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
        // A no-op after `loaded` (which sets liveAfter). The subscribe's live `reset` frame catches up
        // again in the reducer, in the commit that applies it, so a reconnect's replay never fades
        // (U3 §8.3, §11.3).
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
        // The command list is the global handler's (`invalidateCommands`): no state, no commit.
        if (m.type === "agent_commands_changed") return;
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

  // U3 §11.3: an offset gap asks the server for the whole live state, once per gap. The reducer only
  // counts; the ref keeps a StrictMode re-run (or a re-render) from sending the same request twice.
  const snapshotSent = useRef(0);
  useEffect(() => {
    if (state.snapshotWanted <= snapshotSent.current) return;
    snapshotSent.current = state.snapshotWanted;
    wsRef.current.send({ type: "live_snapshot", agent: slug });
  }, [state.snapshotWanted, slug]);

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
  // `rawRows` are what the events say (the announcer counts each failure there); `rows` are what the
  // timeline shows.
  const { rawRows, open, textHead } = useStabilized(events, stableRaw);
  const rows = useStabilized(rawRows, stableFinal);
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

  /** A summary the layout brought (a terminate or pin response, a refetch): this view takes it. */
  const adoptAgent = useCallback(
    (agent: AgentSummary) => dispatch({ type: "agent", agent }),
    [dispatch],
  );

  // Edit agent saves over this session and writes the saved summary into the detail cache: the view takes what a save
  // changes (the name, the reporting line, grants...), so the header shows the new name at once. Status frames write the
  // same cache without a turn's start or a compaction: taking their whole summary would undo the session's live values,
  // so only the edited fields count, and a write that changes none of them (every status batch) dispatches nothing.
  // Only explicit writes (`setQueryData`); a fetch's result is applied by whoever fetched it (the load,
  // `refreshAgent`), so a slow one never overwrites newer status frames.
  useEffect(() => {
    const cached = qc.getQueryData<AgentDetail>(["agent", slug])?.agent;
    let last = cached && editedFields(cached);
    return qc.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "success" || !e.action.manual) return;
      const [kind, key] = e.query.queryKey;
      if (kind !== "agent" || key !== slug || e.query.queryKey.length !== 2) return;
      const agent = (e.query.state.data as AgentDetail | undefined)?.agent;
      if (!agent) return;
      const fields = editedFields(agent);
      if (last && sameEdited(last, fields)) return;
      last = fields;
      dispatch({ type: "agent_edited", fields });
    });
  }, [qc, slug, dispatch]);

  /** The 202's item replaces its "Sending" block (U3 §13.2). Otherwise, while the socket is down no
   *  `queue` frame will come, so the accepted item shows at once (UI design §4.4); when connected the
   *  frame is authoritative. */
  const onQueued = useCallback(
    (item: QueueItem) => dispatch({ type: "queued", item, live: wsRef.current.status === "open" }),
    [dispatch],
  );
  const onSending = useCallback(
    (block: SendingBlock) => dispatch({ type: "sending", block }),
    [dispatch],
  );
  const onSendFailed = useCallback(
    (clientMessageId: string, unconfirmed?: boolean) =>
      dispatch({ type: "send_failed", clientMessageId, unconfirmed }),
    [dispatch],
  );

  // U3 §6.4: Cancel and Undo. `onFailed`/`onRestored` run in the same step as the state change, so
  // the composer's box and the queue change in one commit.
  const cancelItem = useCallback(
    (item: QueueItem, inBox: boolean, onFailed?: () => void) => {
      dispatch({ type: "cancel", id: item.id, inBox });
      cancelQueued(slug, item.id).catch((e: unknown) => {
        onFailed?.();
        dispatch({ type: "cancel_failed", id: item.id, error: failureText(e) });
      });
    },
    [slug, dispatch],
  );
  const undoCancel = useCallback(
    (id: string, onRestored?: () => void) => {
      restoreQueued(slug, id).then(
        () => {
          onRestored?.();
          dispatch({ type: "restored", id });
        },
        (e: unknown) => dispatch({ type: "restore_failed", id, error: failureText(e) }),
      );
    },
    [slug, dispatch],
  );
  const clearCancelled = useCallback(() => dispatch({ type: "clear_cancelled" }), [dispatch]);

  return {
    state,
    rows,
    rawRows,
    open,
    textHead,
    failedIds,
    interruptedEnds,
    loadEarlier,
    earlierError,
    retry,
    onQueued,
    onSending,
    onSendFailed,
    cancelItem,
    undoCancel,
    clearCancelled,
    adoptAgent,
    missingEvent,
    messageSeq,
    messageNotice,
    error,
  };
}
