import type { AgentSummary } from "@open-factory/shared";
import { PanelRight } from "lucide-react";
import { memo, type ReactNode } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentMenu } from "@/features/agents/agent-menu";
import { AgentName } from "@/features/agents/agent-tree";
import {
  AGENT_DETAILS_ID,
  AGENT_DETAILS_TOGGLE_ID,
  type AgentDetailsPanel,
} from "@/features/session/agent-details";
import {
  canPin,
  LiveLine,
  liveFact,
  PinButton,
  type PinOutcome,
} from "@/features/session/live-line";
import { RecoveryActions } from "@/features/session/recovery-actions";
import { StatusBadge, statusLabel } from "@/features/session/status-badge";
import type { StopCrons } from "@/features/session/stop-crons";
import { cn } from "@/lib/utils";
import type { AgentView } from "./view-memory";

const VIEW_TITLE: Record<AgentView, string> = { chat: "Chat", session: "Session" };

/** The header both views share (U3 §11.4, M1): memoized on the agent and stable handlers, so a live
 *  frame, a chat refetch or a `?event=` change (none of which touch these props) never re-renders it. */
export const AgentHeader = memo(function AgentHeader({
  agent,
  view,
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
  view: AgentView;
  panel: AgentDetailsPanel;
  stop: StopCrons;
  slotsMax: number | undefined;
  onRestartError(message: string | undefined): void;
  onPinOutcome(o: PinOutcome | undefined): void;
  onAgent(a: AgentSummary): void;
  onTerminateStart(): void;
  onTerminated(a: AgentSummary, ok: boolean): void;
  /** Archive, its Undo, or Restore from the menu: the agent refetches. */
  onLifecycle(): void;
}) {
  const archived = agent.archivedAt !== null;
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
      documentTitle={`${statusLabel(agent.status, "short")} · ${agent.displayName} · ${VIEW_TITLE[view]}`}
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
        <AgentActions
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

function AgentActions({
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
