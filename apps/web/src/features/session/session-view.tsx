import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleAlert, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { NotFound } from "@/components/route-states";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentStrip } from "./agent-strip";
import { runningQueryOptions } from "./api";
import { CompactPopover } from "./compact-popover";
import { Composer } from "./composer";
import { InterruptButton } from "./interrupt-button";
import { QueueItems } from "./queue-items";
import { RecoveryActions } from "./recovery-actions";
import type { Row } from "./rows";
import { StatusBadge, statusAnnouncement, statusLabel } from "./status-badge";
import { Timeline } from "./timeline";
import { useAgentStatusFrames } from "./use-agent-status";
import { useSession } from "./use-session";

export function SessionView({ slug, eventSeq }: { slug: string; eventSeq?: number }) {
  useAgentStatusFrames();
  const s = useSession(slug, eventSeq);
  const navigate = useNavigate();
  const agent = s.state.agent;
  const announce = useAnnouncer(agent?.displayName ?? slug, agent, s.rows, !!agent);
  // The slot cap for "Queued: all 8 slots are in use." (only fetched once the agent is queued).
  const running = useQuery({ ...runningQueryOptions, enabled: agent?.status === "queued" });
  if (s.error?.code === "agent_not_found") return <NotFound />;
  if (!agent) {
    if (!s.error) return null; // the route's pending component covers the first load
    return (
      <>
        <PageHeader title={slug} />
        <LoadError message={s.error.message} onRetry={() => void s.retry()} />
      </>
    );
  }
  const working = agent.status === "working";
  const archived = agent.archivedAt !== null;
  return (
    <div className="flex h-svh min-h-0 flex-col">
      {!archived && (
        <a
          href="#composer"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to composer
        </a>
      )}
      <PageHeader
        title={agent.displayName}
        documentTitle={`${statusLabel(agent.status, "short")} · ${agent.displayName}`}
        meta={
          <>
            <span className="max-md:hidden">
              <StatusBadge
                status={agent.status}
                rateLimitedUntil={agent.rateLimitedUntil}
                rateLimitExact={agent.rateLimitExact}
                size="long"
              />
            </span>
            <span className="md:hidden">
              <StatusBadge status={agent.status} size="short" />
            </span>
          </>
        }
        actions={<SessionActions agent={agent} archived={archived} />}
      />
      <AgentStrip agent={agent} slotsMax={running.data?.max} />
      {s.missingEvent !== undefined && (
        <p className="shrink-0 px-4 pt-3 text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:px-6">
          Event {s.missingEvent} isn't in this session. Showing the latest.
        </p>
      )}
      {s.error && <LoadError message={s.error.message} onRetry={() => void s.retry()} />}
      <Timeline
        slug={slug}
        rows={s.rows}
        failedIds={s.failedIds}
        interruptedEnds={s.interruptedEnds}
        highlightSeq={s.missingEvent === undefined ? eventSeq : undefined}
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
                <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">
                  <span className="of-tooth" />
                </span>
                Working
              </p>
            )}
          </>
        }
      />
      {s.state.windowed && (
        <div className="flex shrink-0 justify-center py-2">
          <Button
            variant="ghost"
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
      ) : (
        <Composer slug={slug} agent={agent} onQueued={s.onQueued} />
      )}
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

/** Announces replies, errors and status changes only (never every tool call). */
function useAnnouncer(name: string, agent: AgentSummary | undefined, rows: Row[], loaded: boolean) {
  const status = agent?.status;
  const until = agent?.rateLimitedUntil;
  const exact = agent?.rateLimitExact;
  const prevStatus = useRef(status);
  const prevErrors = useRef<number | undefined>(undefined);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (status && prevStatus.current && status !== prevStatus.current)
      setMsg(
        prevStatus.current === "working" && status === "idle"
          ? `${name} replied`
          : statusAnnouncement(name, status, { rateLimitedUntil: until, rateLimitExact: exact }),
      );
    prevStatus.current = status;
  }, [status, name, until, exact]);
  const errorCount = rows.filter((r) => r.kind === "error").length;
  const lastError = rows.findLast((r): r is Extract<Row, { kind: "error" }> => r.kind === "error");
  useEffect(() => {
    // The first render with rows (history load) announces nothing.
    if (prevErrors.current !== undefined && errorCount > prevErrors.current)
      setMsg(`Error: ${lastError?.event.message ?? ""}`);
    if (loaded) prevErrors.current = errorCount;
  }, [errorCount, lastError, loaded]);
  return msg;
}

function SessionActions({ agent, archived }: { agent: AgentSummary; archived: boolean }) {
  const slug = agent.slug;
  return (
    <>
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
      {/* An archived agent has no process: nothing to compact or interrupt (UI design §4.4). While
          errored, the recovery actions replace them, so the header never holds more than two. */}
      {!archived &&
        (agent.status === "errored" ? (
          <RecoveryActions agent={agent} />
        ) : (
          <>
            <CompactPopover slug={slug} />
            <InterruptButton slug={slug} turnOpen={agent.turnOpen} />
          </>
        ))}
    </>
  );
}
