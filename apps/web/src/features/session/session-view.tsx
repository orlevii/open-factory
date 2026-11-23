import type { AgentSummary, QueueItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, PanelRight } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentAvatar } from "@/components/agent-avatar";
import { InlineOutcome } from "@/components/inline-outcome";
import { warmHighlighter } from "@/components/markdown/highlight";
import { PageHeader } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentMenu } from "@/features/agents/agent-menu";
import { AgentName } from "@/features/agents/agent-tree";
import { ArchivedNotice } from "@/features/agents/archived-notice";
import { sessionQueryOptions } from "@/lib/session";
import { cn } from "@/lib/utils";
import { TurnActivity } from "./activity-line";
import {
  AGENT_DETAILS_ID,
  AGENT_DETAILS_TOGGLE_ID,
  AgentDetails,
  type AgentDetailsPanel,
} from "./agent-details";
import {
  agentDetailQueryOptions,
  agentsListQueryOptions,
  runningQueryOptions,
  summaryFromAgentsList,
} from "./api";
import { commandsQueryOptions } from "./commands";
import { Composer, type ComposerHandle, focusReadOnly, TerminatedComposer } from "./composer";
import { childrenOf } from "./display-passes";
import { canPin, LiveLine, liveFact, PinButton, type PinOutcome } from "./live-line";
import { parseSendResults } from "./outgoing-message";
import { QueueItems } from "./queue-items";
import { RecoveryActions } from "./recovery-actions";
import type { Row } from "./rows";
import type { CancelledEntry } from "./session-state";
import { SpeakerProvider } from "./speaker-line";
import { StatusBadge, statusAnnouncement, statusLabel } from "./status-badge";
import { CronsStopLayer, type StopCrons, useStopCrons } from "./stop-crons";
import { Timeline } from "./timeline";
import { recallText, uploadsFor, uploadsUsedSince } from "./uploads";
import { useReadFrom } from "./use-read-from";
import { useSession } from "./use-session";

export function SessionView({
  slug,
  eventSeq,
  messageId,
  panel,
  sheetHost,
}: {
  slug: string;
  eventSeq?: number;
  messageId?: string;
  /** Agent details' state, held above this view so it outlives a switch of agent. */
  panel: AgentDetailsPanel;
  /** The peek sheet's (or drawer's) body while it is mounted: Agent details is portalled into it. */
  sheetHost: HTMLElement | null;
}) {
  const s = useSession(slug, eventSeq, messageId);
  // The highlighter's import lands in idle time while the session opens, before any stream (U3 §11.4).
  useEffect(() => warmHighlighter(), []);
  const { data: me } = useQuery(sessionQueryOptions);
  // Cancel puts the message back into an empty box; Undo takes it out again if untouched (U3 §6.4).
  const composerRef = useRef<ComposerHandle>(null);
  const { cancelItem, undoCancel } = s;
  const onCancel = useCallback(
    (item: QueueItem) => {
      const body = item.body ?? "";
      // A command never comes back as text: Enter would send it as a message (U3 §13.3).
      const inBox = item.kind !== "raw" && (composerRef.current?.putBackIfEmpty(body) ?? false);
      cancelItem(
        item,
        inBox,
        inBox ? () => composerRef.current?.clearIfUnchanged(body) : undefined,
      );
    },
    [cancelItem],
  );
  const onUndo = useCallback(
    (id: string, entry: CancelledEntry) => {
      const body = entry.item.body ?? "";
      undoCancel(id, entry.inBox ? () => composerRef.current?.clearIfUnchanged(body) : undefined);
    },
    [undoCancel],
  );
  useReadFrom(slug, s.state.ordered.at(-1)?.at);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The `/` menu's list loads beside the session, never behind it (m11): an open menu reads the cache.
  useEffect(() => {
    void qc.prefetchQuery(commandsQueryOptions(slug));
  }, [qc, slug]);
  const loaded = s.state.agent;
  // Until the session has loaded, the header and Agent details render from the cached list's
  // summary (spec §11; the route didn't wait for the detail), or on a cold load from the detail the
  // route did wait for (useSession reads it again for its lastSeq). Deliberate non-reactive cache
  // reads during render: useSession's state takes over as soon as it loads.
  const agent =
    loaded ??
    summaryFromAgentsList(qc, slug) ??
    qc.getQueryData(agentDetailQueryOptions(slug).queryKey)?.agent;
  // The announcer hears the loaded agent only: a stale summary's status turning into the real one
  // isn't a transition.
  // The unmerged rows: a repeated failure folded into one timeline row is still announced (U3 §7.6).
  const announce = useAnnouncer(agent?.displayName ?? slug, loaded, s.rawRows, !!loaded);
  // The slot cap for "Queued: all 8 slots are in use." (only fetched once the agent is queued).
  const running = useQuery({ ...runningQueryOptions, enabled: agent?.status === "queued" });
  // A send that raced the termination (409 agent_terminated): the read-only line keeps saying so.
  const [raceNotice, setRaceNotice] = useState<string>();
  // The header's actions report here, in a notice row under it: a failed Restart, a Pin outcome.
  const [restartError, setRestartError] = useState<string>();
  const [pinOutcome, setPinOutcome] = useState<PinOutcome>();
  // Stop crons belongs to the session (U2 §8.4): Agent details and the ⋯ menu both open it.
  const stop = useStopCrons(agent);
  // Terminated while viewing (S7 UI design §5.3): by the spawner, another human or the TTL, never
  // by this human's own confirmed Terminate (that focuses Pin workspace when the dialog closes).
  // Open popovers and dialogs close as their controls unmount; focus goes to the read-only line.
  const selfTerminating = useRef(false);
  // The loaded status only: a stale list summary turning into the real status isn't a transition.
  const status = loaded?.status;
  // A failed Restart belongs to that Errored spell: leaving it clears the notice (adjusted during
  // render on the status edge, no effect).
  const [noticeStatus, setNoticeStatus] = useState(status);
  if (status !== noticeStatus) {
    setNoticeStatus(status);
    if (status !== "errored") setRestartError(undefined);
  }
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status !== "terminated" || was === undefined || was === "terminated") return;
    if (!selfTerminating.current) focusReadOnly(false);
  }, [status]);
  // An agent that couldn't load has no details: an open sheet would stay empty (the error states
  // have no toggle), so it closes.
  const failed = s.error?.code === "agent_not_found" || (!loaded && !!s.error);
  const sheetOpen = panel.open && panel.mode !== "inflow";
  const closePanel = panel.setOpen;
  useEffect(() => {
    if (failed && sheetOpen) closePanel(false);
  }, [failed, sheetOpen, closePanel]);
  // Leaving `?event` remounts the view (the route keys it), which loads the newest page.
  const leaveWindow = useCallback(
    () => void navigate({ to: "/agents/$slug", params: { slug }, search: {} }),
    [navigate, slug],
  );
  // A live frame changes only `state.live`: everything below is memoized on its own inputs, so the
  // header, Agent details, the queue and the composer never re-render for one (U3 §11.4, M1).
  const { setAgent, refreshAgent } = s;
  const onTerminateStart = useCallback(() => {
    selfTerminating.current = true;
  }, []);
  const onTerminated = useCallback(
    (a: AgentSummary, ok: boolean) => {
      selfTerminating.current = ok;
      if (ok) setAgent(a);
    },
    [setAgent],
  );
  // Stable, so the memoised composer doesn't render for frames that change nothing it reads (U3 M3).
  const onSendRaced = useCallback(
    (notice: string) => {
      setRaceNotice(notice);
      void refreshAgent();
    },
    [refreshAgent],
  );
  const closeSheet = useCallback(() => closePanel(false), [closePanel]);
  const slotsMax = running.data?.max;
  const inflow = panel.mode === "inflow" && panel.open;
  const inflowDetails = useMemo(
    () =>
      agent && inflow ? (
        <AgentDetails agent={agent} stop={stop} slotsMax={slotsMax} onAgent={setAgent} />
      ) : null,
    [agent, inflow, stop, slotsMax, setAgent],
  );
  const sheetDetails = useMemo(
    () =>
      agent && sheetHost ? (
        <AgentDetails
          agent={agent}
          stop={stop}
          slotsMax={slotsMax}
          onAgent={setAgent}
          onClose={closeSheet}
        />
      ) : null,
    [agent, sheetHost, stop, slotsMax, setAgent, closeSheet],
  );
  const cronsLayer = useMemo(
    () => (agent ? <CronsStopLayer agent={agent} stop={stop} /> : null),
    [agent, stop],
  );
  const self = me?.user.handle;
  const { queue, sending, cancelled, stopEpoch, landed } = s.state;
  const queueItems = useMemo(
    () =>
      agent ? (
        <QueueItems
          items={queue}
          sending={sending}
          agent={agent}
          cancelled={cancelled}
          self={self}
          onCancel={onCancel}
          onUndo={onUndo}
        />
      ) : null,
    [queue, sending, agent, cancelled, self, onCancel, onUndo],
  );
  const { onQueued, onSending, onSendFailed, clearCancelled } = s;
  // ↑ recall reads the loaded timeline when the key is pressed, so a new event never renders the composer.
  const orderedRef = useRef(s.state.ordered);
  // A delivered message of yours used its uploads: any chip still holding one goes (a send that landed
  // after its 15s abort and a remount, whose chips came back). Only events past the last look are read.
  const lookedThrough = useRef({ slug, seq: 0 });
  const userId = me?.user.id;
  useEffect(() => {
    const ordered = s.state.ordered;
    orderedRef.current = ordered;
    if (!self) return; // read again once you are known
    const from = lookedThrough.current.slug === slug ? lookedThrough.current.seq : 0;
    const used = uploadsUsedSince(ordered, from, self);
    lookedThrough.current = { slug, seq: ordered.at(-1)?.seq ?? from };
    if (used.length) uploadsFor(userId, slug).forgetUploads(used);
  }, [s.state.ordered, slug, self, userId]);
  const recall = useCallback(() => recallText(orderedRef.current, self), [self]);
  const composer = useMemo(
    () =>
      agent ? (
        <Composer
          ref={composerRef}
          docked
          slug={slug}
          agent={agent}
          stopEpoch={stopEpoch}
          // A send before the session loads would be lost when the load replaces the queue.
          waiting={!loaded}
          onQueued={onQueued}
          onSending={onSending}
          onSendFailed={onSendFailed}
          landed={landed}
          onSent={clearCancelled}
          onTerminated={onSendRaced}
          recall={recall}
          context="session"
        />
      ) : null,
    [
      slug,
      agent,
      stopEpoch,
      loaded,
      onQueued,
      onSending,
      onSendFailed,
      landed,
      clearCancelled,
      onSendRaced,
      recall,
    ],
  );
  // The route only maps an unknown slug itself when nothing was cached; a cached one lands here.
  if (s.error?.code === "agent_not_found")
    return (
      <ResourceNotFound title="Agent not found." backTo="/agents" backLabel="Back to agents" />
    );
  if (!loaded && s.error)
    return (
      <>
        <PageHeader title={agent?.displayName ?? slug} />
        <LoadError message={s.error.message} onRetry={() => void s.retry()} />
      </>
    );
  if (!agent) return null; // nothing cached and the route's fetch failed: useSession's answer or error follows
  const archived = agent.archivedAt !== null;
  const terminated = agent.status === "terminated";
  const errored = agent.status === "errored";
  return (
    <div className="flex h-svh min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {!archived && !terminated && (
          <a
            href="#composer"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm"
          >
            Skip to composer
          </a>
        )}
        <SessionHeader
          agent={agent}
          archived={archived}
          panel={panel}
          stop={stop}
          slotsMax={slotsMax}
          onRestartError={setRestartError}
          onPinOutcome={setPinOutcome}
          onAgent={setAgent}
          onTerminateStart={onTerminateStart}
          onTerminated={onTerminated}
          onLifecycle={refreshAgent}
        />
        {errored && restartError && (
          <p
            role="alert"
            className="flex shrink-0 items-center gap-1.5 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-destructive md:px-6"
          >
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0">Couldn't restart: {restartError}</span>
          </p>
        )}
        {terminated && (
          // Mounted while terminated (before it fills) so the outcome is announced.
          <div className="shrink-0 px-4 md:px-6">
            <InlineOutcome tone={pinOutcome?.tone}>{pinOutcome?.text}</InlineOutcome>
          </div>
        )}
        {cronsLayer}
        {s.missingEvent !== undefined && (
          <p className="shrink-0 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
            Event {s.missingEvent} isn't in this session. Showing the latest.
          </p>
        )}
        {s.messageNotice && (
          <p className="shrink-0 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
            {s.messageNotice.kind === "rejected" ? (
              <RejectedReason to={s.messageNotice.to} viewed={agent} />
            ) : s.messageNotice.kind === "cancelled" ? (
              "You cancelled this message."
            ) : (
              "Message not found. Showing the latest."
            )}
          </p>
        )}
        {s.error && <LoadError message={s.error.message} onRetry={() => void s.retry()} />}
        {/* One speaker index for every row (U3 §7.2, m7): the agent as primitives, so a status frame
            changes nothing in it. Mounted while the events load, so the users and agents lists
            fetch alongside them and no name pops in after the first paint. */}
        <SpeakerProvider
          slug={agent.slug}
          displayName={agent.displayName}
          template={agent.template}
          kind={agent.kind}
          avatarVersion={agent.avatarVersion}
        >
          {loaded ? (
            <Timeline
              ref={panel.timeline}
              slug={slug}
              spawned={agent.kind === "ephemeral"}
              rows={s.rows}
              failedIds={s.failedIds}
              interruptedEnds={s.interruptedEnds}
              liveAfter={s.state.liveAfter}
              handedOff={s.state.handedOff}
              highlightSeq={s.missingEvent === undefined ? (eventSeq ?? s.messageSeq) : undefined}
              highlightMessageId={eventSeq === undefined ? messageId : undefined}
              hasMoreBefore={s.state.hasMoreBefore}
              onLoadEarlier={s.loadEarlier}
              earlierError={s.earlierError}
              windowed={s.state.windowed}
              newSpeech={s.state.newSpeech}
              onLeaveWindow={leaveWindow}
              liveTexts={s.state.live.texts}
              subagents={s.state.live.subagents}
              textHead={s.textHead}
              footer={
                <>
                  {s.rows.length === 0 &&
                    s.state.queue.length === 0 &&
                    s.state.sending.length === 0 &&
                    s.state.cancelled.size === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {archived
                          ? "No messages yet."
                          : "No messages yet. Send the first one below."}
                      </p>
                    )}
                  {/* Time order under the last row: now, then next (U3 §5.2). */}
                  {agent.turnOpen && !s.state.windowed && (
                    <TurnActivity
                      open={s.open}
                      live={s.state.live}
                      startedAt={agent.turnStartedAt}
                      turnKey={String(s.state.turnEpoch)}
                      compacting={agent.compacting === true}
                    />
                  )}
                  {queueItems}
                </>
              }
            />
          ) : (
            <TimelineSkeleton />
          )}
        </SpeakerProvider>
        <div role="status" aria-live="polite" className="sr-only">
          {announce}
        </div>
        {archived ? (
          <ArchivedNotice slug={slug} onRestored={refreshAgent} />
        ) : terminated ? (
          <TerminatedComposer slug={slug} notice={raceNotice} />
        ) : (
          composer
        )}
      </div>
      {inflow && (
        <aside
          id={AGENT_DETAILS_ID}
          aria-label="Agent details"
          className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border bg-card"
        >
          {inflowDetails}
        </aside>
      )}
      {/* Kept while the sheet's node exists, so its exit animation still shows the content. */}
      {sheetHost && sheetDetails && createPortal(sheetDetails, sheetHost)}
    </div>
  );
}

/** The session's header (U3 §11.4, M1): memoized on the agent and stable handlers, so a live frame
 *  (which changes neither) never re-renders it. */
const SessionHeader = memo(function SessionHeader({
  agent,
  archived,
  panel,
  stop,
  slotsMax,
  onRestartError,
  onPinOutcome,
  onAgent,
  onTerminateStart,
  onTerminated,
  onLifecycle,
}: {
  agent: AgentSummary;
  archived: boolean;
  panel: AgentDetailsPanel;
  stop: StopCrons;
  slotsMax: number | undefined;
  onRestartError(message: string | undefined): void;
  onPinOutcome(o: PinOutcome | undefined): void;
  onAgent(a: AgentSummary): void;
  onTerminateStart(): void;
  onTerminated(a: AgentSummary, ok: boolean): void;
  /** Archive, its Undo, or Restore from the menu: the session refetches its agent. */
  onLifecycle(): void;
}) {
  // A third header action (Restart / Start a new session, or Pin) beside Agent details and ⋯, each a 40px box on
  // touch: below a 22rem header (320px) the avatar gives way so the row stays one line (break H3, evidence D2).
  const crowded =
    (!archived && agent.status === "errored") || (agent.status === "terminated" && canPin(agent));
  return (
    <PageHeader
      title={agent.displayName}
      titleFromData
      leading={
        <span data-header-avatar className={cn("contents", crowded && "@max-[22rem]:hidden")}>
          <AgentAvatar
            slug={agent.slug}
            template={agent.template}
            avatarVersion={agent.avatarVersion}
            size={24}
          />
        </span>
      }
      heading={<AgentName agent={agent} />}
      titleClassName="max-w-[45%]"
      documentTitle={`${statusLabel(agent.status, "short")} · ${agent.displayName}`}
      meta={
        <>
          <span className="shrink-0 max-md:hidden">
            <StatusBadge
              status={agent.status}
              rateLimitedUntil={agent.rateLimitedUntil}
              rateLimitExact={agent.rateLimitExact}
              size="long"
            />
          </span>
          <span className="shrink-0 md:hidden">
            <StatusBadge status={agent.status} size="short" />
          </span>
          <LiveLine fact={liveFact(agent, { slotsMax: slotsMax, now: new Date() })} />
        </>
      }
      actions={
        <SessionActions
          agent={agent}
          archived={archived}
          panel={panel}
          onRestartError={onRestartError}
          onPinOutcome={onPinOutcome}
          onAgent={onAgent}
          actionsMenu={
            <AgentMenu
              agent={agent}
              context="session"
              stop={stop}
              onOpenDetails={() => panel.setOpen(true)}
              detailsTakeFocus={panel.mode !== "inflow"}
              onTerminateStart={onTerminateStart}
              onTerminated={onTerminated}
              onLifecycle={onLifecycle}
            />
          }
        />
      }
    />
  );
});

/** Static rows where the timeline will be, while the session loads behind a cached header. */
function TimelineSkeleton() {
  return (
    <div data-timeline-skeleton aria-hidden="true" className="min-h-0 flex-1 px-4 py-4 md:px-6">
      <div className="grid max-w-[52rem] gap-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16" />
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-10 w-5/6" />
      </div>
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-3 text-sm md:px-6">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0">Couldn't load this session: {message}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

type RowScan = {
  /** Every outgoing `send_message` row, including those nested under a subagent's call. */
  outgoing: Extract<Row, { kind: "outgoing" }>[];
  highestSeq: number;
  /** Top-level error rows only. */
  errorCount: number;
  lastError: Extract<Row, { kind: "error" }> | undefined;
};

/** What the announcer needs from the rows, in one walk rather than a scan per question. */
function scanRows(rows: Row[]): RowScan {
  const scan: RowScan = { outgoing: [], highestSeq: 0, errorCount: 0, lastError: undefined };
  const walk = (list: readonly Row[], top: boolean) => {
    for (const r of list) {
      if (r.seq > scan.highestSeq) scan.highestSeq = r.seq;
      if (r.kind === "outgoing") scan.outgoing.push(r);
      else if (top && r.kind === "error") {
        scan.errorCount++;
        scan.lastError = r;
      }
      walk(childrenOf(r), false);
    }
  };
  walk(rows, true);
  return scan;
}

/** Announces messages to the viewer, errors and status changes only (never every tool call, and
 *  not updates, peer events or messages between agents). */
function useAnnouncer(name: string, agent: AgentSummary | undefined, rows: Row[], loaded: boolean) {
  const status = agent?.status;
  const until = agent?.rateLimitedUntil;
  const exact = agent?.rateLimitExact;
  const prevStatus = useRef(status);
  const prevErrors = useRef<number | undefined>(undefined);
  const [msg, setLiveText] = useState("");
  // A live region only speaks when its text changes: the same announcement twice in a row
  // alternates a zero-width space so the second one is announced too.
  const setMsg = useCallback(
    (text: string) => setLiveText((prev) => (prev === text ? `${text}\u200b` : text)),
    [],
  );
  const { data: me } = useQuery(sessionQueryOptions);
  const handle = me?.user.handle;
  useEffect(() => {
    if (status && prevStatus.current && status !== prevStatus.current)
      setMsg(statusAnnouncement(name, status, { rateLimitedUntil: until, rateLimitExact: exact }));
    prevStatus.current = status;
  }, [status, name, until, exact, setMsg]);
  // An agent's text is not a reply to anyone: announce a successful message to this human.
  // Only sends newer than what was on screen at load count, so Load earlier and reloads stay quiet,
  // plus calls that were on screen at load still waiting for their result.
  const baseSeq = useRef<number | undefined>(undefined);
  const pendingAtLoad = useRef(new Set<number>());
  const announced = useRef(new Set<number>());
  const slug = agent?.slug;
  const scan = useMemo(() => scanRows(rows), [rows]);
  useEffect(() => {
    if (!loaded) return;
    if (baseSeq.current === undefined) {
      baseSeq.current = scan.highestSeq;
      for (const r of scan.outgoing) if (!r.result) pendingAtLoad.current.add(r.seq);
    }
    for (const r of scan.outgoing) {
      const toMe =
        handle !== undefined &&
        parseSendResults(r.result)?.results.some(
          (x) => "kind" in x && x.kind === "human" && x.to === `@${handle}`,
        ) === true;
      const fresh = r.seq > baseSeq.current || pendingAtLoad.current.has(r.seq);
      if (toMe && fresh && !announced.current.has(r.seq)) {
        announced.current.add(r.seq);
        setMsg(`@${slug} messaged you`);
      }
    }
  }, [scan, loaded, handle, slug, setMsg]);
  const { errorCount, lastError } = scan;
  useEffect(() => {
    // The first render with rows (history load) announces nothing.
    if (prevErrors.current !== undefined && errorCount > prevErrors.current)
      setMsg(`Error: ${lastError?.event.message ?? ""}`);
    if (loaded) prevErrors.current = errorCount;
  }, [errorCount, lastError, loaded, setMsg]);
  return msg;
}

/** "This message wasn't delivered: @dev was terminated." or "…was archived." (S7 UI design §5.3), from
 *  the recipient's state: the viewed agent itself, else the ended list. When neither says (the list
 *  failed, or the recipient is older than its newest 200), "…is no longer available.", which never
 *  guesses. Nothing until it is known. */
function RejectedReason({ to, viewed }: { to: string; viewed: AgentSummary }) {
  const self = to === viewed.slug ? viewed : undefined;
  const ended = useQuery({
    ...agentsListQueryOptions("only"),
    enabled: !self,
    staleTime: 30_000,
  });
  if (!self && ended.isPending) return null;
  const recipient = self ?? ended.data?.find((a) => a.slug === to);
  const why =
    recipient?.terminatedAt || recipient?.status === "terminated"
      ? "was terminated"
      : recipient?.archivedAt
        ? "was archived"
        : "is no longer available";
  return (
    <>
      This message wasn't delivered: <span className="font-mono">@{to}</span> {why}.
    </>
  );
}

function SessionActions({
  agent,
  archived,
  panel,
  actionsMenu,
  onRestartError,
  onPinOutcome,
  onAgent,
}: {
  agent: AgentSummary;
  archived: boolean;
  panel: AgentDetailsPanel;
  actionsMenu: ReactNode;
  onRestartError(message: string | undefined): void;
  onPinOutcome(o: PinOutcome | undefined): void;
  onAgent(a: AgentSummary): void;
}) {
  // Edit, Compact, Stop crons and Terminate are in the ⋯ menu (U2 §8.2); the header keeps what
  // can't wait: Pin, Restart. Stop sits in the composer, where the turn is (U3 §6.1, §14). A
  // terminated agent's session is read-only for good.
  const live = !archived && agent.status !== "terminated";
  return (
    <>
      {agent.status === "terminated" && canPin(agent) && (
        <PinButton agent={agent} onAgent={onAgent} onOutcome={onPinOutcome} header />
      )}
      {live && <RecoveryActions agent={agent} onError={onRestartError} />}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            id={AGENT_DETAILS_TOGGLE_ID}
            variant="ghost"
            size="icon"
            aria-label="Agent details"
            aria-expanded={panel.open}
            aria-controls={AGENT_DETAILS_ID}
            onClick={panel.toggle}
          >
            <PanelRight aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Agent details</TooltipContent>
      </Tooltip>
      {actionsMenu}
    </>
  );
}
