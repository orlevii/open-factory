import type { AgentSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { CompactPopover } from "../session/compact-popover";
import type { StopCrons } from "../session/stop-crons";
import { TerminateButton } from "../session/terminate-button";

/**
 * The one actions menu for an agent (U2 §8.4), in the session header and on a sidebar row.
 * Compact… and Terminate… open their own overlays from the menu's ⋯ button, so the menu hands
 * focus over instead of returning it. Stop crons state belongs to the session (`stop`), which
 * mounts the confirmation.
 */
export function AgentMenu({
  agent,
  context,
  stop,
  onOpenDetails,
  onTerminateStart = () => {},
  onTerminated = () => {},
  triggerClassName,
}: {
  agent: AgentSummary;
  context: "session" | "sidebar";
  stop?: StopCrons;
  onOpenDetails?: () => void;
  onTerminateStart?: () => void;
  onTerminated?: (a: AgentSummary, ok: boolean) => void;
  triggerClassName?: string;
}) {
  const slug = agent.slug;
  const trigger = useRef<HTMLButtonElement>(null);
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactPending, setCompactPending] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const session = context === "session";
  const archived = agent.archivedAt !== null;
  const live = !archived && agent.status !== "terminated";
  const spawned = agent.kind === "ephemeral";
  const canCompact = session && live && agent.status !== "errored";
  const canEdit = !spawned && !archived;
  const canStopCrons = session && stop !== undefined && agent.crons.length > 0;
  const canTerminate = session && spawned && live;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${agent.displayName}`}
            className={cn(triggerClassName)}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Compact… opens a popover anchored on the ⋯ button: focus belongs to it, not back here.
          onCloseAutoFocus={(e) => {
            if (compactPending) {
              e.preventDefault();
              setCompactPending(false);
            }
          }}
        >
          {!session && (
            <DropdownMenuItem asChild>
              <Link to="/agents/$slug" params={{ slug }}>
                Open session
              </Link>
            </DropdownMenuItem>
          )}
          {session && (
            <DropdownMenuItem onSelect={() => onOpenDetails?.()}>
              Agent details
              <DropdownMenuShortcut>
                <Kbd keys={["]"]} />
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {canCompact && (
            <DropdownMenuItem
              onSelect={() => {
                setCompactPending(true);
                requestAnimationFrame(() => setCompactOpen(true));
              }}
            >
              Compact…
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem asChild>
              <Link to="/agents/$slug/edit" params={{ slug }}>
                Edit
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link to="/agents/$slug/usage" params={{ slug }}>
              Usage
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/tasks" search={{ assignee: slug }}>
              Open tasks
            </Link>
          </DropdownMenuItem>
          {canStopCrons && (
            <DropdownMenuItem
              onSelect={() => {
                stop.setPopover(false);
                stop.setConfirm(true);
              }}
            >
              Stop crons…
            </DropdownMenuItem>
          )}
          {canTerminate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setTerminateOpen(true)}>
                Terminate…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canCompact && (
        <CompactPopover
          slug={slug}
          open={compactOpen}
          onOpenChange={setCompactOpen}
          anchor={trigger}
        />
      )}
      {spawned && session && (
        <TerminateButton
          agent={agent}
          onStart={onTerminateStart}
          onTerminated={onTerminated}
          open={terminateOpen}
          onOpenChange={setTerminateOpen}
          returnFocusTo={trigger}
        />
      )}
    </>
  );
}
