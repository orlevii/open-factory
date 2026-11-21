import type { AgentSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleAlert, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentName } from "@/features/agents/agent-tree";
import { agentsUsageQuery } from "@/features/usage/api";
import { sessionQueryOptions } from "@/lib/session";
import { AgentStrip } from "./agent-strip";
import { agentsListQueryOptions, runningQueryOptions, summaryFromAgentsList } from "./api";
import { CompactPopover } from "./compact-popover";
import { Composer, focusReadOnly, TerminatedComposer } from "./composer";
import { InterruptButton } from "./interrupt-button";
import { parseSendResult } from "./outgoing-message";
import { QueueItems } from "./queue-items";
import { RecoveryActions } from "./recovery-actions";
import type { Row } from "./rows";
import { StatusBadge, statusAnnouncement, statusLabel } from "./status-badge";
import { TerminateButton } from "./terminate-button";
import { Timeline } from "./timeline";
import { useAgentStatusFrames } from "./use-agent-status";
import { useSession } from "./use-session";

export function SessionView({
  slug,
  eventSeq,
  messageId,
}: {
  slug: string;
  eventSeq?: number;
  messageId?: string;
}) {
  useAgentStatusFrames();
  const s = useSession(slug, eventSeq, messageId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const loaded = s.state.agent;
  // Until the session has loaded, the header and strip render from the cached list's summary (spec
  // §11; the route didn't wait for the detail). A deliberate non-reactive read of the list cache
  // during render: useSession's state takes over as soon as it loads.
  const agent = loaded ?? summaryFromAgentsList(qc, slug);
  const announce = useAnnouncer(agent?.displayName ?? slug, agent, s.rows, !!loaded);
  // The slot cap for "Queued: all 8 slots are in use." (only fetched once the agent is queued).
  const running = useQuery({ ...runningQueryOptions, enabled: agent?.status === "queued" });
  const usageRows = useQuery(agentsUsageQuery("rolling7"));
  // A send that raced the termination (409 agent_terminated): the read-only line keeps saying so.
  const [raceNotice, setRaceNotice] = useState<string>();
  // Terminated while viewing (S7 UI design §5.3): by the spawner, another human or the TTL, never
  // by this human's own confirmed Terminate (that focuses Pin workspace when the dialog closes).
  // Open popovers and dialogs close as their controls unmount; focus goes to the read-only line.
  const selfTerminating = useRef(false);
  // The loaded status only: a stale list summary turning into the real status isn't a transition.
  const status = loaded?.status;
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status !== "terminated" || was === undefined || was === "terminated") return;
    if (!selfTerminating.current) focusReadOnly(false);
  }, [status]);
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
  if (!agent) return null; // the route's pending component covers the first load
  const working = agent.status === "working";
  const archived = agent.archivedAt !== null;
  const terminated = agent.status === "terminated";
  return (
    <div className="flex h-svh min-h-0 flex-col">
      {!archived && !terminated && (
        <a
          href="#composer"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to composer
        </a>
      )}
      <PageHeader
        title={agent.displayName}
        titleFromData
        heading={<AgentName agent={agent} />}
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
          </>
        }
        actions={
          <SessionActions
            agent={agent}
            turnEpoch={s.state.turnEpoch}
            archived={archived}
            onTerminateStart={() => {
              selfTerminating.current = true;
            }}
            onTerminated={(a, ok) => {
              selfTerminating.current = ok;
              if (ok) s.setAgent(a);
            }}
          />
        }
      />
      <AgentStrip
        agent={agent}
        slotsMax={running.data?.max}
        usage={
          usageRows.data
            ? (usageRows.data.agents.find((r) => r.slug === agent.slug) ?? null)
            : undefined
        }
        onAgent={s.setAgent}
      />
      {s.missingEvent !== undefined && (
        <p className="shrink-0 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
          Event {s.missingEvent} isn't in this session. Showing the latest.
        </p>
      )}
      {s.messageNotice && (
        <p className="shrink-0 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
          {s.messageNotice.kind === "rejected" ? (
            <RejectedReason to={s.messageNotice.to} viewed={agent} />
          ) : (
            "Message not found. Showing the latest."
          )}
        </p>
      )}
      {s.error && <LoadError message={s.error.message} onRetry={() => void s.retry()} />}
      {loaded ? (
        <Timeline
          slug={slug}
          spawned={agent.kind === "ephemeral"}
          rows={s.rows}
          failedIds={s.failedIds}
          interruptedEnds={s.interruptedEnds}
          highlightSeq={s.missingEvent === undefined ? (eventSeq ?? s.messageSeq) : undefined}
          highlightMessageId={eventSeq === undefined ? messageId : undefined}
          hasMoreBefore={s.state.hasMoreBefore}
          onLoadEarlier={s.loadEarlier}
          earlierError={s.earlierError}
          footer={
            <>
              {s.rows.length === 0 && s.state.queue.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {archived ? "No messages yet." : "No messages yet. Send the first one below."}
                </p>
              )}
              <QueueItems items={s.state.queue} agent={agent} />
              {working && (
                <p
                  data-working-line
                  className="flex h-6 items-center gap-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex size-3 items-center justify-center"
                  >
                    <span className="of-tooth" />
                  </span>
                  Working
                </p>
              )}
            </>
          }
        />
      ) : (
        <TimelineSkeleton />
      )}
      {s.state.windowed && (
        <div className="flex shrink-0 justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            // Leaving `?event` remounts the view (the route keys it), which loads the newest page.
            onClick={() => void navigate({ to: "/agents/$slug", params: { slug }, search: {} })}
          >
            Jump to latest · {s.state.newWhileAway} new
          </Button>
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
      {archived ? (
        <p className="shrink-0 border-t border-border px-4 py-3 text-sm text-muted-foreground md:px-6">
          This agent is archived.{" "}
          <Link
            to="/agents/$slug/edit"
            params={{ slug }}
            className="text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring"
          >
            Restore it
          </Link>{" "}
          to send messages.
        </p>
      ) : terminated ? (
        <TerminatedComposer slug={slug} notice={raceNotice} />
      ) : (
        <Composer
          slug={slug}
          agent={agent}
          onQueued={s.onQueued}
          onTerminated={(notice) => {
            setRaceNotice(notice);
            void s.refreshAgent();
          }}
        />
      )}
    </div>
  );
}

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
  const walk = (list: Row[], top: boolean) => {
    for (const r of list) {
      if (r.seq > scan.highestSeq) scan.highestSeq = r.seq;
      if (r.kind === "outgoing") scan.outgoing.push(r);
      else if (r.kind === "tool") walk(r.children, false);
      else if (top && r.kind === "error") {
        scan.errorCount++;
        scan.lastError = r;
      }
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
  // An agent's text is not a reply to anyone: announce a successful message to this human or all.
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
      const to = parseSendResult(r.result)?.to;
      const toMe =
        to !== undefined && (to === "@humans" || (handle !== undefined && to === `@${handle}`));
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
  turnEpoch,
  archived,
  onTerminateStart,
  onTerminated,
}: {
  agent: AgentSummary;
  turnEpoch: number;
  archived: boolean;
  onTerminateStart(): void;
  onTerminated(a: AgentSummary, ok: boolean): void;
}) {
  const slug = agent.slug;
  // A spawned agent has no Edit (its settings are inherited, S7 UI design §5.2) but has Terminate.
  const spawned = agent.kind === "ephemeral";
  // A terminated agent's session is read-only for good: no actions at all (§5.3).
  const live = !archived && agent.status !== "terminated";
  return (
    <>
      {!spawned && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" asChild>
              <Link to="/agents/$slug/edit" params={{ slug }}>
                <Pencil aria-hidden="true" />
                <span className="max-md:sr-only">Edit</span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="md:hidden">Edit</TooltipContent>
        </Tooltip>
      )}
      {/* An archived agent has no process: nothing to compact or interrupt (UI design §4.4). While
          errored, the recovery actions replace them, so the header never holds more than two. */}
      {live && agent.status !== "errored" && (
        <>
          <CompactPopover slug={slug} />
          <InterruptButton slug={slug} turnOpen={agent.turnOpen} turnEpoch={turnEpoch} />
        </>
      )}
      {live && <RecoveryActions agent={agent} />}
      {/* A 1px rule (16px tall) keeps Terminate apart from Interrupt's Square; the row's gap is the
          8px margin. */}
      {spawned && live && (
        <span data-action-divider aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
      )}
      {spawned && (
        <TerminateButton agent={agent} onStart={onTerminateStart} onTerminated={onTerminated} />
      )}
    </>
  );
}
