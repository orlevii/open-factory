import type { ChatEntry, ChatPage, ServerMessage } from "@open-factory/shared";
import { type QueryClient, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stripAttachedLines } from "@/features/session/uploads";
import { useWs } from "@/lib/ws-context";
import { chatAroundQueryOptions, chatQueryOptions, fetchChat } from "./api";
import {
  type ChatData,
  type ChatThread,
  flattenPages,
  keysOf,
  liveKeys,
  meetsCache,
  mergeNewest,
  withoutSending,
} from "./chat-state";

/** A gap of more pages than this between the cache and now is not walked: the next refresh tries again. */
const MAX_GAP_PAGES = 20;

type Source = "frame" | "other";
type Refresh = {
  inflight: Promise<void> | null;
  trailing: Promise<void> | null;
  trailingSource: Source;
};

const refreshes = new WeakMap<QueryClient, Map<string, Refresh>>();
/** Per (client, agentRef): the keys on screen when the view's live window last moved (I1 §6.4). */
const cursors = new WeakMap<QueryClient, Map<string, ReadonlySet<string>>>();

const perClient = <T>(store: WeakMap<QueryClient, Map<string, T>>, qc: QueryClient) => {
  const had = store.get(qc);
  if (had) return had;
  const m = new Map<string, T>();
  store.set(qc, m);
  return m;
};

const dataOf = (qc: QueryClient, agentRef: string) =>
  qc.getQueryData<ChatData>(chatQueryOptions(agentRef).queryKey);

function setCursor(qc: QueryClient, agentRef: string, data: ChatData | undefined) {
  perClient(cursors, qc).set(agentRef, keysOf(data ? flattenPages(data).entries : []));
}

/** The newest page, written through the union. A frame that arrives while the tab is hidden moves the
 *  cursor like any other refetch: nothing fades for a reader who isn't looking. */
async function run(qc: QueryClient, agentRef: string, source: Source) {
  const opts = chatQueryOptions(agentRef);
  const had = dataOf(qc, agentRef);
  try {
    if (!had) {
      await qc.fetchInfiniteQuery(opts);
      return;
    }
    const fetched = [await fetchChat(agentRef)];
    // More than a page arrived between refreshes: walk older until the pages meet the cache.
    const head = had.pages[0];
    for (
      let last = fetched[0] as ChatPage;
      !meetsCache(last, head) && fetched.length <= MAX_GAP_PAGES;
    ) {
      last = await fetchChat(agentRef, { before: last.nextCursor as string });
      fetched.push(last);
    }
    // The gap was too wide to walk: the fetched pages replace the cache rather than leave a hole in it.
    const gap = !meetsCache(fetched[fetched.length - 1] as ChatPage, head);
    // Otherwise the cache may have moved while fetching (Load earlier): merge into what is there now.
    const next: ChatData = gap
      ? {
          pages: fetched,
          pageParams: fetched.map((_, i) =>
            i === 0 ? "" : ((fetched[i - 1] as ChatPage).nextCursor as string),
          ),
        }
      : mergeNewest(dataOf(qc, agentRef), fetched);
    if (gap || source === "other" || document.hidden) setCursor(qc, agentRef, next);
    qc.setQueryData(opts.queryKey, next);
  } catch {
    // A failed first load stays the query's error state (shown with Retry); a failed refresh keeps
    // what is on screen. The next frame, focus or reconnect tries again.
  }
}

/**
 * Refreshes the newest page of one chat (I1 §6.5): one request in flight and one trailing, however
 * many frames arrive; callers share the promise of the run that will include their change.
 */
export function refreshChat(qc: QueryClient, agentRef: string, source: Source): Promise<void> {
  const all = perClient(refreshes, qc);
  const state = all.get(agentRef) ?? { inflight: null, trailing: null, trailingSource: "frame" };
  all.set(agentRef, state);
  const start = (s: Source) => {
    const p = run(qc, agentRef, s).finally(() => {
      if (state.inflight === p) state.inflight = null;
    });
    state.inflight = p;
    return p;
  };
  if (!state.inflight) return start(source);
  if (source === "other") state.trailingSource = "other";
  if (!state.trailing) {
    state.trailing = state.inflight.then(() => {
      const s = state.trailingSource;
      state.trailing = null;
      state.trailingSource = "frame";
      return start(s);
    });
  }
  return state.trailing;
}

/** The global socket handler's entry (`routes/_app.tsx`): a `chat_changed` refreshes a chat that is
 *  open; any other chat is refreshed when it opens. */
export function onChatChanged(qc: QueryClient, m: ServerMessage): void {
  if (m.type !== "chat_changed") return;
  const q = qc.getQueryCache().find({ queryKey: chatQueryOptions(m.agent).queryKey, exact: true });
  if (q && q.getObserversCount() > 0) void refreshChat(qc, m.agent, "frame");
}

/** Your send, in the thread at once (I1 §6.4): an entry of the thread's own list, keyed by its
 *  `clientMessageId`, which the server's row takes over. Not before the thread has loaded. */
export function addSending(qc: QueryClient, agentRef: string, entry: ChatEntry): void {
  const had = dataOf(qc, agentRef);
  const head = had?.pages[0];
  if (!head) return;
  const page: ChatPage = { ...head, entries: [entry], nextCursor: null };
  qc.setQueryData(chatQueryOptions(agentRef).queryKey, mergeNewest(had, [page]));
}

/** The send failed: its block goes (the server's row, if it landed anyway, stays). */
export function dropSending(qc: QueryClient, agentRef: string, clientMessageId: string): void {
  const had = dataOf(qc, agentRef);
  if (!had) return;
  const next = withoutSending(had, clientMessageId);
  if (next !== had) qc.setQueryData(chatQueryOptions(agentRef).queryKey, next);
}

/** Your newest message's text in the loaded thread (↑ in the empty composer). */
export function lastSentText(qc: QueryClient, agentRef: string): string | undefined {
  const data = dataOf(qc, agentRef);
  if (!data) return undefined;
  const entries = flattenPages(data).entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as ChatEntry;
    if (e.kind === "message" && e.from.kind === "human")
      return stripAttachedLines(e.body, e.attachments);
  }
  return undefined;
}

/** The turn that read your message, as the key the page names it by (undefined: none), and whether
 *  the thread has loaded. The composer reads only this, so a new entry never renders it. */
export function useWorkingKey(
  agentRef: string,
  /** Off for a `?message=` window: it shows no working line, and the thread isn't fetched twice. */
  enabled: boolean,
): { key: string | undefined; loaded: boolean } {
  const q = useInfiniteQuery({
    ...chatQueryOptions(agentRef),
    enabled,
    select: (d) => d.pages[0]?.working?.key ?? null,
  });
  return { key: q.data ?? undefined, loaded: !enabled || q.status === "success" };
}

const NO_LIVE: ReadonlySet<string> = new Set();

export type UseChat = {
  entries: ChatEntry[];
  working: ChatPage["working"];
  /** Keys of the entries that arrived live and fade in. */
  live: ReadonlySet<string>;
  loadEarlier(): Promise<void>;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierError: boolean;
  /** The pages end before the newest entry: a `?message=` window. */
  windowed: boolean;
  status: "pending" | "error" | "success";
  error: Error | null;
  retry(): void;
};

const NOTHING: ChatThread = { entries: [], working: null, hasEarlier: false, windowed: false };

/** One human's thread with one agent (I1 §6.4, §6.5): the entries, oldest first, with stable
 *  objects; the working line's data; which entries arrived live. A `messageId` opens the window
 *  around it, which no frame changes. */
export function useChat(agentRef: string, o: { messageId?: string | undefined } = {}): UseChat {
  const { messageId } = o;
  const qc = useQueryClient();
  const { openCount } = useWs();
  const around = messageId !== undefined;
  const q = useInfiniteQuery({
    ...(around ? chatAroundQueryOptions(agentRef, messageId) : chatQueryOptions(agentRef)),
    select: flattenPages,
  });
  const { fetchNextPage, isFetchNextPageError, isFetchingNextPage } = q;
  const thread = q.data ?? NOTHING;

  // A mounting view starts its live window at what it shows: nothing fades on load, on a reading
  // pane retarget or on a Chat/Session switch (idempotent, so safe to repeat).
  // This runs during render on purpose: `live` below is computed in the same render and must already see
  // the mount-time cursor, which an effect would set a render too late (the first paint would fade everything).
  // The module map is per client and keyed by agentRef; a discarded concurrent render writes the same value.
  // A `?message=` window never touches the thread's cursor.
  useState(() => !around && perClient(cursors, qc).delete(agentRef));
  const cursor = perClient(cursors, qc);
  if (!around && q.data && !cursor.has(agentRef)) cursor.set(agentRef, keysOf(thread.entries));
  // The working line the view showed last: the outcome that replaces it never fades.
  const shownWorking = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (thread.working) shownWorking.current = thread.working.key;
  }, [thread.working]);
  const live = useMemo(() => {
    const held = perClient(cursors, qc).get(agentRef);
    return around || !held ? NO_LIVE : liveKeys(thread.entries, held, shownWorking.current);
  }, [thread.entries, around, qc, agentRef]);

  // Focus and a reopened socket refresh the newest page (frames come through the global handler).
  useEffect(() => {
    if (around) return;
    const refresh = () => void refreshChat(qc, agentRef, "other");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [qc, agentRef, around]);
  // The socket's first open follows the loader's fetch; a later one is a reconnect that may have missed frames.
  const opened = useRef(openCount);
  useEffect(() => {
    const first = opened.current === 0;
    if (opened.current === openCount) return;
    opened.current = openCount;
    if (!first && !around) void refreshChat(qc, agentRef, "other");
  }, [openCount, qc, agentRef, around]);

  const loadEarlier = useCallback(async () => {
    await fetchNextPage();
    // What it brought is older than everything shown: not live.
    const { queryKey } = messageId
      ? chatAroundQueryOptions(agentRef, messageId)
      : chatQueryOptions(agentRef);
    setCursor(qc, agentRef, qc.getQueryData<ChatData>(queryKey));
  }, [fetchNextPage, qc, agentRef, messageId]);
  // Retry fetches the first page again (through the union when the thread has pages), never every loaded page in turn.
  const retry = useCallback(() => {
    if (!around && dataOf(qc, agentRef)) void refreshChat(qc, agentRef, "other");
    else
      void qc
        .fetchInfiniteQuery(
          around ? chatAroundQueryOptions(agentRef, messageId) : chatQueryOptions(agentRef),
        )
        .catch(() => {});
  }, [qc, agentRef, around, messageId]);
  return {
    entries: thread.entries,
    working: around ? null : thread.working,
    live,
    loadEarlier,
    hasEarlier: thread.hasEarlier,
    loadingEarlier: isFetchingNextPage,
    earlierError: isFetchNextPageError,
    windowed: thread.windowed,
    status: q.status,
    error: q.error,
    retry,
  };
}
