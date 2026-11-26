import type { ChatEntry } from "@open-factory/shared";
import { ApiError } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { warmHighlighter } from "@/components/markdown/highlight";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentActions } from "@/features/agents/agent-layout";
import { ArchivedNotice } from "@/features/agents/archived-notice";
import { useHandle } from "@/features/agents/use-agent-index";
import { useAgentSummary } from "@/features/agents/use-agent-summary";
import { readViewPosition, useRememberPosition } from "@/features/agents/view-memory";
import { cancelQueued, restoreQueued } from "@/features/session/api";
import { NETWORK_ERROR } from "@/features/session/composer";
import { JumpPill } from "@/features/session/jump-pill";
import { registerTimelineRepin } from "@/features/session/session-commands";
import { SpeakerProvider } from "@/features/session/speaker-line";
import { useStickToBottom } from "@/features/session/stick-to-bottom";
import { useReadFrom } from "@/features/session/use-read-from";
import { sessionQueryOptions } from "@/lib/session";
import { INBOX_DWELL_MS } from "@/lib/timing";
import { arrive, useArrivalTint } from "@/lib/use-arrival";
import { ChatComposer } from "./chat-composer";
import { type CancelNote, ChatRow, rowGap } from "./chat-row";
import { continuesGroup, entryKey, isSending, keysOf } from "./chat-state";
import { outcomeSentence, TurnLine } from "./turn-line";
import { refreshChat, useChat, useWorkingKey } from "./use-chat";

const toHandle = (s: { user: { handle: string } } | null) => s?.user.handle;
const toUserId = (s: { user: { id: string } } | null) => s?.user.id;
const failureText = (e: unknown) => (e instanceof ApiError ? e.message : NETWORK_ERROR);
const NO_NOTES: ReadonlyMap<string, CancelNote> = new Map();

/** The chat page: the Chat inside the agent layout, which refetches the agent after a restore. */
export function ChatView({
  agentRef,
  messageId,
}: {
  agentRef: string;
  messageId?: string | undefined;
}) {
  const { refreshAgent } = useAgentActions();
  const onRestored = useCallback(() => void refreshAgent(), [refreshAgent]);
  return <ChatBody agentRef={agentRef} messageId={messageId} onRestored={onRestored} />;
}

/** What the Inbox's reading pane changes about the Chat: it reads after the dwell, opens at the first
 *  of the `unread` messages, takes no page docking, and fetches the agent itself (no layout did). */
export type PaneOptions = { unread: number; latestId: string };

/**
 * The chat with one agent (I1 §6.4): one column, newest at the bottom, the reader's place kept.
 * Read as it is shown: at once on the page, after INBOX_DWELL_MS in the pane. The pane's Chat is this
 * same component on the same cache, so your optimistic message is the cache's, never a second list.
 */
export function ChatBody({
  agentRef,
  messageId,
  pane,
  onRestored,
}: {
  agentRef: string;
  messageId?: string | undefined;
  pane?: PaneOptions;
  onRestored(): void;
}) {
  // The highlighter's import lands in idle time while the thread loads, before any reply renders.
  useEffect(() => warmHighlighter(), []);
  const agent = useAgentSummary(agentRef, pane ? {} : { refetchOnMount: false });
  const handle = useHandle(agentRef);
  const archived = agent?.archivedAt != null;
  const terminated = agent?.status === "terminated";
  const session = useQuery({ ...sessionQueryOptions, select: toHandle }).data;
  const userId = useQuery({ ...sessionQueryOptions, select: toUserId }).data;
  const turn = useWorkingKey(agentRef, messageId === undefined);
  // From a `?message=` window the newest page is what a send lands in: the chat goes back to it.
  const navigate = useNavigate();
  const leaveWindow = useCallback(
    () => void navigate({ to: "/agents/$ref/chat", params: { ref: agentRef }, search: {} }),
    [navigate, agentRef],
  );
  return (
    <>
      <SpeakerProvider
        agentRef={agentRef}
        {...(agent
          ? {
              displayName: agent.displayName,
              template: agent.template,
              kind: agent.kind,
              avatarVersion: agent.avatarVersion,
              color: agent.color,
            }
          : {})}
      >
        <Thread
          agentRef={agentRef}
          messageId={messageId}
          pane={pane}
          agentName={agent?.displayName ?? `@${handle}`}
          leaveWindow={leaveWindow}
        />
      </SpeakerProvider>
      {archived && agent ? (
        <ArchivedNotice agent={agent} onRestored={onRestored} />
      ) : terminated ? (
        <div className="shrink-0 border-t border-border px-4 py-3 md:px-6">
          <p data-readonly-line className="max-w-[52rem] text-sm text-muted-foreground">
            This agent was terminated. The chat is read-only.
          </p>
        </div>
      ) : (
        <ChatComposer
          agentRef={agentRef}
          agentName={agent?.displayName ?? `@${handle}`}
          userId={userId}
          working={turn.key !== undefined}
          workingKey={turn.key}
          turnOpen={agent?.turnOpen === true}
          compacting={agent?.compacting === true}
          waiting={!turn.loaded || session === undefined}
          docked={!pane}
          {...(messageId !== undefined ? { onSend: leaveWindow } : {})}
        />
      )}
    </>
  );
}

function Thread({
  agentRef,
  messageId,
  pane,
  agentName,
  leaveWindow,
}: {
  agentRef: string;
  messageId: string | undefined;
  pane: PaneOptions | undefined;
  agentName: string;
  leaveWindow(): void;
}) {
  const chat = useChat(agentRef, { messageId });
  const { entries, working, live, windowed, status } = chat;
  const self = useQuery({ ...sessionQueryOptions, select: toHandle }).data;
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const loaded = status === "success";

  // The newest message from the agent: what viewing the chat reads, once its dwell (the pane's) is up.
  const newestAgentAt = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as ChatEntry;
      if (e.kind === "message" && e.from.kind === "agent") return e.createdAt;
    }
    return undefined;
  }, [entries]);
  useReadFrom(agentRef, newestAgentAt, { delayMs: pane ? INBOX_DWELL_MS : 0 });

  // The pane opens at the first unread message: the `unread` agent messages ending at the chat row's
  // newest (`latestId`), fixed once that message is in the thread (reading them doesn't move it). A
  // cached thread older than the row waits for the refresh below; more unread than the thread holds
  // gets no divider (the oldest loaded message isn't the first unread).
  const [unreadKey, setUnreadKey] = useState<string | null>();
  const latestAt = pane
    ? entries.findIndex((e) => e.kind === "message" && e.id === pane.latestId)
    : -1;
  if (loaded && pane && unreadKey === undefined && (pane.unread === 0 || latestAt >= 0)) {
    const theirs = entries
      .slice(0, latestAt + 1)
      .filter((e) => e.kind === "message" && e.from.kind === "agent");
    const first = pane.unread > 0 ? theirs[theirs.length - pane.unread] : undefined;
    setUnreadKey(first ? entryKey(first) : null);
  }
  // A thread cached before the row's newest message (a prefetch, an earlier visit) is refreshed once.
  const qc = useQueryClient();
  const stale = loaded && pane !== undefined && pane.unread > 0 && latestAt < 0;
  useEffect(() => {
    if (stale) void refreshChat(qc, agentRef, "other");
  }, [stale, qc, agentRef]);
  const unreadDone = useRef(false);

  // The highest entry on screen when the reader left the bottom; the pill counts what came after.
  const [seen, setSeen] = useState<ReadonlySet<string>>();
  const latest = useRef(entries);
  useLayoutEffect(() => {
    latest.current = entries;
  }, [entries]);
  const stick = useStickToBottom(scroller, log, (pinned) =>
    setSeen(pinned ? undefined : keysOf(latest.current)),
  );
  const isPinned = useCallback(() => stick.pinned.current, [stick]);
  // Sending follows the conversation again.
  useEffect(() => registerTimelineRepin(agentRef, stick.repin), [agentRef, stick]);
  useRememberPosition(agentRef, "chat", scroller, isPinned, !windowed && !pane);

  // The deep link: the thread opens around the message and tints it, as the session does.
  const targetKey = useMemo(() => {
    if (!messageId) return undefined;
    const hit = entries.find((e) => e.kind === "message" && e.id === messageId);
    return hit && entryKey(hit);
  }, [entries, messageId]);
  const { arrival, start: startArrival, onArrivedEnd } = useArrivalTint();
  const centred = useRef(false);
  const restored = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every content commit (the height changed)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (targetKey !== undefined && !centred.current) {
      centred.current = true;
      restored.current = true;
      stick.unpin();
      const row = el.querySelector<HTMLElement>(`[data-row="${CSS.escape(targetKey)}"]`);
      row?.scrollIntoView?.({ block: "center" });
      if (row) arrive(row);
      startArrival();
      return;
    }
    // The pane: the first unread message at the top when what is unread is taller than the pane, else the bottom.
    if (unreadKey && !unreadDone.current && loaded) {
      unreadDone.current = true;
      restored.current = true;
      const divider = el.querySelector<HTMLElement>("[data-new-divider]");
      if (divider && el.scrollHeight - divider.offsetTop > el.clientHeight) {
        stick.unpin();
        divider.scrollIntoView?.({ block: "start" });
        return;
      }
    }
    if (!restored.current && loaded) {
      restored.current = true;
      const left = windowed ? undefined : readViewPosition(agentRef, "chat");
      if (left && !left.pinned) {
        stick.unpin();
        el.scrollTop = left.top;
        return;
      }
    }
    // Pinned: the bottom, at once. Unpinned: the anchor row keeps its place (Load earlier included).
    stick.settle();
  }, [entries, working, loaded, targetKey, unreadKey, stick, agentRef, windowed]);
  // Cancel and Undo of a held message of yours, in the row's place.
  const [notes, setNotes] = useState<ReadonlyMap<string, CancelNote>>(NO_NOTES);
  const setNote = useCallback((id: string, note: CancelNote | undefined) => {
    setNotes((m) => {
      const next = new Map(m);
      if (note) next.set(id, note);
      else next.delete(id);
      return next;
    });
  }, []);
  const onCancel = useCallback(
    (id: string) => {
      setNote(id, {});
      cancelQueued(agentRef, id).catch((e: unknown) =>
        setNote(id, { error: failureText(e), rolledBack: true }),
      );
    },
    [agentRef, setNote],
  );
  const onUndo = useCallback(
    (id: string) => {
      restoreQueued(agentRef, id).then(
        () => setNote(id, undefined),
        (e: unknown) => setNote(id, { error: failureText(e) }),
      );
    },
    [agentRef, setNote],
  );

  // One tab stop in the log; the arrows move between rows.
  const [activeKey, setActiveKey] = useState<string>();
  const onRowFocus = useCallback((k: string) => setActiveKey(k), []);
  // The first message until one is focused, as the session's timeline: appending never changes it.
  const firstKey = useMemo(() => {
    const first = entries.find((e) => e.kind === "message");
    return first && entryKey(first);
  }, [entries]);
  const tabKey =
    activeKey !== undefined && entries.some((e) => entryKey(e) === activeKey)
      ? activeKey
      : firstKey;
  const onKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active?.hasAttribute("data-row")) return;
    const list = [...(log.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const i = list.indexOf(active);
    const go = (n: number) => {
      e.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") {
      go(list.length - 1);
      stick.repin();
    }
  };

  const rowEls = useMemo(
    () =>
      entries.flatMap((e, i) => {
        const key = entryKey(e);
        const divider = key === unreadKey ? <NewDivider key="new-divider" /> : null;
        // One speaker line for a run of messages: a divider, an outcome or a cancelled message breaks it.
        const before = entries[i - 1];
        const cancelled = before?.kind === "message" && notes.get(before.id)?.rolledBack === false;
        const grouped = !divider && !cancelled && continuesGroup(before, e);
        const el =
          e.kind === "turn_outcome" ? (
            <TurnLine
              key={key}
              agentRef={agentRef}
              name={agentName}
              at={e.endedAt}
              outcome={e.outcome}
              eventSeq={e.eventSeq}
              live={live.has(key)}
              gap={rowGap(i === 0, true)}
            />
          ) : (
            <ChatRow
              key={key}
              entry={e}
              agentRef={agentRef}
              agentName={agentName}
              self={self}
              live={live.has(key)}
              grouped={grouped}
              gap={grouped ? "mt-1" : rowGap(i === 0)}
              tabbable={key === tabKey}
              arrival={key === targetKey ? arrival : undefined}
              note={notes.get(e.id)}
              onCancel={onCancel}
              onUndo={onUndo}
              onRowFocus={onRowFocus}
              onArrivedEnd={onArrivedEnd}
            />
          );
        return divider ? [divider, el] : [el];
      }),
    [
      entries,
      unreadKey,
      live,
      agentRef,
      agentName,
      self,
      tabKey,
      targetKey,
      arrival,
      notes,
      onCancel,
      onUndo,
      onRowFocus,
      onArrivedEnd,
    ],
  );

  // The working line fades in only when it appears while the thread is open, never on load or a switch.
  const [baseline, setBaseline] = useState<string | null>();
  if (loaded && baseline === undefined) setBaseline(working?.key ?? null);
  const workingEl =
    working && !entries.some((e) => e.kind === "turn_outcome" && e.key === working.key) ? (
      <TurnLine
        key={`turn:${working.key}`}
        agentRef={agentRef}
        name={agentName}
        at={working.since}
        live={baseline !== undefined && working.key !== baseline}
        gap={rowGap(entries.length === 0, true)}
      />
    ) : null;

  // What arrived live, for assistive tech: the log itself is not live. Empty on load.
  const announce = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as ChatEntry;
      if (!live.has(entryKey(e))) continue;
      if (e.kind === "turn_outcome") return `${outcomeSentence(agentName, e.outcome)}.`;
      if (e.from.kind === "agent") return `${agentName}: ${e.body.split("\n", 1)[0]}`;
    }
    return "";
  }, [entries, live, agentName]);

  // Your messages' state changes, for assistive tech: held, delivered after being held, not delivered.
  const states = useRef(new Map<string, string>());
  const [stateNote, setStateNote] = useState("");
  useEffect(() => {
    const before = states.current;
    const next = new Map<string, string>();
    let note = "";
    for (const e of entries) {
      if (e.kind !== "message" || e.from.kind !== "human") continue;
      const state = isSending(e) ? "sending" : e.state;
      next.set(entryKey(e), state);
      const was = before.get(entryKey(e));
      if (was === state || (was === undefined && state !== "pending")) continue;
      if (state === "pending") note = `Waiting for ${agentName}'s current step.`;
      else if (state === "rejected")
        note = e.rejectReason ? `Not delivered: ${e.rejectReason}` : "Not delivered.";
      else if (state === "delivered" && was === "pending") note = `Delivered to ${agentName}.`;
    }
    states.current = next;
    if (note) setStateNote(note);
  }, [entries, agentName]);

  const speech = useMemo(() => {
    if (!seen) return 0;
    let n = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as ChatEntry;
      if (seen.has(entryKey(e))) break;
      if (e.kind === "message") n++;
    }
    return n;
  }, [entries, seen]);
  const onJump = useCallback(() => {
    if (windowed) return leaveWindow();
    stick.repin();
    const rows = log.current?.querySelectorAll<HTMLElement>("[data-row]");
    rows?.[rows.length - 1]?.focus({ preventScroll: true });
  }, [windowed, leaveWindow, stick]);

  const loadEarlier = async () => {
    // The top visible row keeps its place when the earlier entries land above it.
    stick.expandAnchor();
    await chat.loadEarlier();
  };

  return (
    <div className="relative min-h-0 flex-1">
      {/* `relative`: an absolute descendant (a name's `sr-only` copy) is held and clipped here. Without
          it the box escapes to the wrapper at its unscrolled place and stretches the page below. */}
      <div
        ref={scroller}
        data-chat-view
        className="relative h-full overflow-y-auto px-4 py-4 md:px-6"
      >
        <div
          ref={log}
          role="log"
          aria-label="Chat"
          aria-live="off"
          onKeyDown={onKeyDown}
          className="max-w-[52rem] min-w-0 overflow-x-clip"
        >
          {status === "pending" && <ChatSkeleton />}
          {status === "error" && (
            <div className="flex items-center gap-2 text-sm">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0">Couldn't load this chat.</span>
              <Button variant="ghost" size="sm" onClick={chat.retry}>
                Retry
              </Button>
            </div>
          )}
          {loaded && chat.hasEarlier && (
            <div className="mb-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadEarlier()}
                disabled={chat.loadingEarlier}
              >
                {chat.loadingEarlier ? "Loading…" : "Load earlier"}
              </Button>
              {chat.earlierError && (
                <span className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
                  Couldn't load earlier messages.
                </span>
              )}
            </div>
          )}
          {loaded && entries.length === 0 && !working && (
            <p className="text-sm text-muted-foreground">No messages with {agentName} yet.</p>
          )}
          {/* One flat keyed list: the working line and the outcome that replaces it share a key. */}
          {workingEl ? [...rowEls, workingEl] : rowEls}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {[stateNote, announce].filter(Boolean).join(" ")}
      </div>
      {/* Centred on the 52rem column, not the scroller. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 px-4 md:px-6">
        <div className="relative max-w-[52rem]">
          <JumpPill
            shown={windowed || speech > 0}
            speech={speech}
            other={false}
            windowed={windowed}
            onJump={onJump}
          />
        </div>
      </div>
    </div>
  );
}

/** Where the unread messages begin, when the pane opened on them. */
function NewDivider() {
  return (
    <div
      data-new-divider
      className="my-3 flex items-center gap-2 text-xs font-medium text-muted-foreground"
    >
      <span>New</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Static speech rows where the thread will be. */
function ChatSkeleton() {
  return (
    <div data-chat-skeleton aria-hidden="true" className="grid gap-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-16" />
      <Skeleton className="h-4 w-1/4" />
      <Skeleton className="h-10 w-5/6" />
    </div>
  );
}
