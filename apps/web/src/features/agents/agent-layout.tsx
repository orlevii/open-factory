import type { AgentDetail, AgentSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InlineOutcome } from "@/components/inline-outcome";
import { PageHeader } from "@/components/page-header";
import { rememberAgent } from "@/features/palette/recent";
import {
  AGENT_DETAILS_ID,
  AgentDetails,
  type AgentDetailsPanel,
  AgentDetailsSheet,
  useAgentDetailsPanel,
} from "@/features/session/agent-details";
import { agentDetailQueryOptions, runningQueryOptions } from "@/features/session/api";
import type { PinOutcome } from "@/features/session/live-line";
import { CronsStopLayer, type StopCrons, useStopCrons } from "@/features/session/stop-crons";
import { AgentHeader } from "./agent-header";
import { useAgentSummary } from "./use-agent-summary";
import type { AgentView } from "./view-memory";

/** What the views do to the layout. Every member is stable for the layout's life, so reading it
 *  never renders a view. */
export type AgentActions = {
  setRestartError(message: string | undefined): void;
  setPinOutcome(o: PinOutcome | undefined): void;
  /** A send that raced the termination (409 agent_terminated): the read-only line keeps saying so. */
  setRaceNotice(notice: string | undefined): void;
  onTerminateStart(): void;
  onTerminated(a: AgentSummary, ok: boolean): void;
  /** A summary from a terminate or pin response: the cache and the open view take it. */
  onAgent(a: AgentSummary): void;
  /** Refetches the summary only (a send raced a termination; Archive and Restore). */
  refreshAgent(): Promise<void>;
  /** Set by this human's own confirmed Terminate: the read-only line is not focused for it. */
  selfTerminating: RefObject<boolean>;
};

/** What the views read from the layout; changes with the panel, the notice or an adopted summary. */
export type AgentShell = {
  panel: AgentDetailsPanel;
  raceNotice: string | undefined;
  /** The newest summary a terminate, pin or refetch brought: the session adopts it into its state. */
  adopted: { agent: AgentSummary } | undefined;
};

const ActionsContext = createContext<AgentActions | null>(null);
const ShellContext = createContext<AgentShell | null>(null);

function need<T>(value: T | null): T {
  if (!value) throw new Error("Agent layout context is missing");
  return value;
}
export const useAgentActions = () => need(useContext(ActionsContext));
export const useAgentShell = () => need(useContext(ShellContext));

const viewOf = (routeId: string | undefined): AgentView =>
  routeId?.endsWith("/session") ? "session" : "chat";

/** The layout of `/agents/$slug`: the header, Agent details and its sheet, the notices, and the view
 *  (Outlet). It stays mounted across a Chat/Session switch and across `?event=` and `?message=`
 *  (which remount the views only), so the header never remounts for them. */
export function AgentLayout({
  slug,
  children = <Outlet />,
}: {
  slug: string;
  /** The view; the route's Outlet unless a test mounts one directly. */
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const agent = useAgentSummary(slug);
  const view = useRouterState({ select: (s) => viewOf(s.matches.at(-1)?.routeId) });
  // Agent details' state and its sheet live here, above the views, so an open panel stays open
  // across agents and the sheet swaps its content in place (U2 §8.1).
  const panel = useAgentDetailsPanel(slug);
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => rememberAgent(slug), [slug]);
  // The slot cap for "Queued: all 8 slots are in use." (only fetched once the agent is queued).
  const running = useQuery({ ...runningQueryOptions, enabled: agent?.status === "queued" });
  const slotsMax = running.data?.max;
  // The header's actions report here, in a notice row under it: a failed Restart, a Pin outcome.
  const [restartError, setRestartError] = useState<string>();
  const [pinOutcome, setPinOutcome] = useState<PinOutcome>();
  const [raceNotice, setRaceNotice] = useState<string>();
  const [adopted, setAdopted] = useState<{ agent: AgentSummary }>();
  // Stop crons belongs to the agent (U2 §8.4): Agent details and the ⋯ menu both open it.
  const stop = useStopCrons(agent);
  const selfTerminating = useRef(false);

  // A failed Restart belongs to that Errored spell: leaving it clears the notice (adjusted during
  // render on the status edge, no effect).
  const status = agent?.status;
  const [noticeStatus, setNoticeStatus] = useState(status);
  if (status !== noticeStatus) {
    setNoticeStatus(status);
    if (status !== "errored") setRestartError(undefined);
  }

  const onAgent = useCallback(
    (a: AgentSummary) => {
      qc.setQueryData<AgentDetail>(["agent", a.slug], (d) => (d ? { ...d, agent: a } : d));
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setAdopted({ agent: a });
    },
    [qc],
  );
  const refreshAgent = useCallback(
    () =>
      qc.fetchQuery({ ...agentDetailQueryOptions(slug), staleTime: 0 }).then(
        (d) => setAdopted({ agent: d.agent }),
        () => {},
      ),
    [qc, slug],
  );
  // A status frame says `terminated` but carries no termination fields (who, when, the workspace):
  // fetch them once. A failure leaves the strip without its sentence; the next load fills it.
  const needsTermination = status === "terminated" && agent?.terminatedAt === undefined;
  useEffect(() => {
    if (needsTermination) void refreshAgent();
  }, [needsTermination, refreshAgent]);

  const onTerminateStart = useCallback(() => {
    selfTerminating.current = true;
  }, []);
  const onTerminated = useCallback(
    (a: AgentSummary, ok: boolean) => {
      selfTerminating.current = ok;
      if (ok) onAgent(a);
    },
    [onAgent],
  );
  const actions = useMemo<AgentActions>(
    () => ({
      setRestartError,
      setPinOutcome,
      setRaceNotice,
      onTerminateStart,
      onTerminated,
      onAgent,
      refreshAgent,
      selfTerminating,
    }),
    [onTerminateStart, onTerminated, onAgent, refreshAgent],
  );
  const shell = useMemo<AgentShell>(
    () => ({ panel, raceNotice, adopted }),
    [panel, raceNotice, adopted],
  );

  const inflow = panel.mode === "inflow" && panel.open;
  const details = (onClose?: () => void) =>
    agent ? (
      <AgentDetails
        agent={agent}
        stop={stop}
        slotsMax={slotsMax}
        onAgent={onAgent}
        onClose={onClose}
      />
    ) : null;
  const closePanel = panel.setOpen;
  const closeSheet = useCallback(() => closePanel(false), [closePanel]);
  const terminated = status === "terminated";
  const archived = agent?.archivedAt !== null;
  return (
    <ActionsContext.Provider value={actions}>
      <ShellContext.Provider value={shell}>
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
            {agent ? (
              <AgentHeader
                agent={agent}
                view={view}
                panel={panel}
                stop={stop}
                slotsMax={slotsMax}
                onRestartError={setRestartError}
                onPinOutcome={setPinOutcome}
                onAgent={onAgent}
                onTerminateStart={onTerminateStart}
                onTerminated={onTerminated}
                onLifecycle={refreshAgent}
              />
            ) : (
              <PageHeader title={slug} />
            )}
            {status === "errored" && restartError && (
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
            {agent && <CronsStopLayer agent={agent} stop={stop} />}
            {children}
          </div>
          {inflow && (
            <aside
              id={AGENT_DETAILS_ID}
              aria-label="Agent details"
              className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border bg-card"
            >
              {details()}
            </aside>
          )}
          {/* Kept while the sheet's node exists, so its exit animation still shows the content. */}
          {sheetHost && createPortal(details(closeSheet), sheetHost)}
        </div>
        <AgentDetailsSheet panel={panel} onHost={setSheetHost} />
      </ShellContext.Provider>
    </ActionsContext.Provider>
  );
}
