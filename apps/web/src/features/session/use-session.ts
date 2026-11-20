import { ApiError, type EventsPage, type QueueItem } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useWs } from "@/lib/ws-context";
import { agentDetailQueryOptions, fetchEvents } from "./api";
import { buildRows, deliveryFailedIds, interruptedTurnEnds } from "./rows";
import { eventsInOrder, highestSeq, initialSessionState, sessionReducer } from "./session-state";

const asApiError = (e: unknown) =>
  e instanceof ApiError
    ? e
    : new ApiError(0, "network_error", e instanceof Error ? e.message : String(e));

/** HTTP pages + WS subscription + dedup by seq + queue + status + the deep-link window. */
export function useSession(slug: string, eventSeq?: number) {
  const ws = useWs();
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [missingEvent, setMissingEvent] = useState<number | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [earlierError, setEarlierError] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const lastSeqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(
    async (around?: number) => {
      try {
        const detail = await qc.fetchQuery({ ...agentDetailQueryOptions(slug), staleTime: 0 });
        lastSeqRef.current = detail.lastSeq;
        let page: EventsPage | undefined;
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
        setError(undefined);
        setLoadedAt(Date.now());
      } catch (e) {
        setError(asApiError(e));
      }
    },
    [qc, slug],
  );

  useEffect(() => {
    void load(eventSeq);
  }, [load, eventSeq]);
  useEffect(() => ws.listen((m) => dispatch({ type: "frame", message: m })), [ws]);

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

  const events = useMemo(() => eventsInOrder(state), [state]);
  const rows = useMemo(() => buildRows(events), [events]);
  const failedIds = useMemo(() => deliveryFailedIds(events), [events]);
  const interruptedEnds = useMemo(() => interruptedTurnEnds(events), [events]);

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
  }, [events, slug]);

  const retry = useCallback(() => load(eventSeq), [load, eventSeq]);

  /** While the socket is down no `queue` frame will come, so show the accepted item at once
   *  (UI design §4.4); when connected the frame is authoritative. */
  const onQueued = useCallback((item: QueueItem) => {
    if (wsRef.current.status !== "open") dispatch({ type: "queued", item });
  }, []);

  return {
    state,
    rows,
    failedIds,
    interruptedEnds,
    loadEarlier,
    earlierError,
    retry,
    onQueued,
    missingEvent,
    error,
  };
}
