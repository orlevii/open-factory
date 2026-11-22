import type { AgentSummary } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
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
import { archiveAgent, restoreAgent, resyncAgent } from "@/features/agents/lifecycle";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { cn } from "@/lib/utils";
import { CompactPopover } from "../session/compact-popover";
import type { StopCrons } from "../session/stop-crons";
import { TerminateButton } from "../session/terminate-button";

const newTaskIntent = sheetIntent("new-task");
const newScheduleIntent = sheetIntent("new-schedule");

/**
 * The one actions menu for an agent (U2 §8.4, U4 §6.5), in the session header, on a sidebar row and
 * on an Agents page row. Grouped: New task, New schedule · Edit, Usage, Open tasks, Agent details,
 * Compact…, Stop crons… · Re-sync from template…, Archive…, Restore, Terminate….
 * Compact… and Terminate… open their own overlays from the menu's ⋯ button, so the menu hands
 * focus over instead of returning it. Stop crons state belongs to the session (`stop`), which
 * mounts the confirmation.
 */
export function AgentMenu({
  agent,
  context,
  stop,
  onOpenDetails,
  detailsTakeFocus = false,
  onTerminateStart = () => {},
  onTerminated = () => {},
  triggerClassName,
  anchored,
  onLifecycle,
}: {
  agent: AgentSummary;
  context: "session" | "sidebar" | "list";
  stop?: StopCrons;
  onOpenDetails?: () => void;
  /** Agent details opens as a sheet that takes focus: the menu hands focus over, as for Compact…. */
  detailsTakeFocus?: boolean;
  onTerminateStart?: () => void;
  onTerminated?: (a: AgentSummary, ok: boolean) => void;
  triggerClassName?: string;
  /** After Archive, its Undo, or Restore: the session holds its own copy of the agent to refresh. */
  onLifecycle?: () => void;
  /** One shared instance for a list (the sidebar tree): controlled, with no ⋯ of its own. It opens
   *  below the right edge of `anchor` (the row the caller names) and hands focus back with `onClose`. */
  anchored?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    anchor: HTMLElement | null;
    onClose: () => void;
  };
}) {
  const slug = agent.slug;
  const trigger = useRef<HTMLButtonElement>(null);
  const [compactOpen, setCompactOpen] = useState(false);
  // An item that opens an overlay taking focus (Compact…, Agent details as a sheet) hands over
  // once the menu has gone, instead of returning focus to ⋯. Opening it while the menu still
  // fades out puts the overlay under the pointer: the item's pointer-leave then focuses the dying
  // menu, which reads as a focus outside and dismisses a popover at once.
  const handoff = useRef<(() => void) | null>(null);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const qc = useQueryClient();
  const session = context === "session";
  const archived = agent.archivedAt !== null;
  const terminated = agent.status === "terminated";
  const live = !archived && !terminated;
  const spawned = agent.kind === "ephemeral";
  // On the Agents page a terminated agent, or an ended spawned one, has only Usage and Open tasks.
  const endedInList = context === "list" && (terminated || (spawned && !live));
  const canCompact = session && live && agent.status !== "errored";
  const canEdit = !spawned && !archived && !endedInList;
  const canStopCrons = session && stop !== undefined && agent.crons.length > 0;
  const canTerminate = session && spawned && live;
  const canResync = !spawned && live;
  const canArchive = !spawned && live;
  const canRestore = archived && !terminated && !endedInList;

  // An item that opens a sheet hands over once the menu has gone, as Compact… does.
  const openAfterClose = (open: () => void) => {
    handoff.current = open;
  };

  const create: ReactElement[] = live
    ? [
        <DropdownMenuItem
          key="new-task"
          {...newTaskIntent}
          onSelect={() => openAfterClose(() => openSheet({ kind: "new-task", assignee: slug }))}
        >
          New task
        </DropdownMenuItem>,
        <DropdownMenuItem
          key="new-schedule"
          {...newScheduleIntent}
          onSelect={() => openAfterClose(() => openSheet({ kind: "new-schedule", target: slug }))}
        >
          New schedule
        </DropdownMenuItem>,
      ]
    : [];
  const views: ReactElement[] = [];
  if (context === "sidebar")
    views.push(
      <DropdownMenuItem key="open" asChild>
        <Link to="/agents/$slug" params={{ slug }}>
          Open session
        </Link>
      </DropdownMenuItem>,
    );
  // Task 23 turns Edit into the edit-agent sheet.
  if (canEdit)
    views.push(
      <DropdownMenuItem key="edit" asChild>
        <Link to="/agents/$slug/edit" params={{ slug }}>
          Edit
        </Link>
      </DropdownMenuItem>,
    );
  views.push(
    <DropdownMenuItem key="usage" asChild>
      <Link to="/agents/$slug/usage" params={{ slug }}>
        Usage
      </Link>
    </DropdownMenuItem>,
    <DropdownMenuItem key="tasks" asChild>
      <Link to="/tasks" search={{ assignee: slug }}>
        Open tasks
      </Link>
    </DropdownMenuItem>,
  );
  if (session)
    views.push(
      <DropdownMenuItem
        key="details"
        onSelect={() => {
          if (!detailsTakeFocus) return onOpenDetails?.();
          handoff.current = () => onOpenDetails?.();
        }}
      >
        Agent details
        <DropdownMenuShortcut>
          <Kbd keys={["]"]} />
        </DropdownMenuShortcut>
      </DropdownMenuItem>,
    );
  if (canCompact)
    views.push(
      <DropdownMenuItem
        key="compact"
        onSelect={() => {
          handoff.current = () => setCompactOpen(true);
        }}
      >
        Compact…
      </DropdownMenuItem>,
    );
  if (canStopCrons)
    views.push(
      <DropdownMenuItem key="stop-crons" onSelect={() => stop.openConfirm(trigger)}>
        Stop crons…
      </DropdownMenuItem>,
    );
  const lifecycle: ReactElement[] = [];
  if (canResync)
    lifecycle.push(
      <DropdownMenuItem key="resync" onSelect={() => void resyncAgent(slug, qc, agent.template)}>
        Re-sync from template…
      </DropdownMenuItem>,
    );
  if (canArchive)
    lifecycle.push(
      <DropdownMenuItem
        key="archive"
        variant="destructive"
        onSelect={() => void archiveAgent(agent, qc, { onChanged: onLifecycle })}
      >
        Archive…
      </DropdownMenuItem>,
    );
  if (canRestore)
    lifecycle.push(
      <DropdownMenuItem
        key="restore"
        onSelect={() => void restoreAgent(slug, qc, { onChanged: onLifecycle })}
      >
        Restore
      </DropdownMenuItem>,
    );
  if (canTerminate)
    lifecycle.push(
      <DropdownMenuItem
        key="terminate"
        variant="destructive"
        onSelect={() => setTerminateOpen(true)}
      >
        Terminate…
      </DropdownMenuItem>,
    );
  const groups = [create, views, lifecycle].filter((g) => g.length > 0);

  // The row's box, measured when the menu opens and kept through the close, so the menu stays
  // over its row while it fades out (the page is scroll-locked while it is open).
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number }>();
  const open = anchored?.open;
  const anchorEl = anchored?.anchor;
  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const { top, left, width, height } = anchorEl.getBoundingClientRect();
    setRect({ top, left, width, height });
  }, [open, anchorEl]);
  return (
    <>
      <DropdownMenu open={anchored?.open} onOpenChange={anchored?.onOpenChange}>
        <DropdownMenuTrigger asChild>
          {anchored ? (
            // A stand-in for the row: fixed over it, invisible and out of the way of pointers.
            <span
              aria-hidden="true"
              data-menu-stand-in=""
              className="pointer-events-none fixed"
              style={
                rect
                  ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
                  : undefined
              }
            />
          ) : (
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${agent.displayName}`}
              className={cn(triggerClassName)}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Compact… opens a popover anchored on the ⋯ button, and Agent details may open a sheet:
          // focus belongs to them, not back here.
          onCloseAutoFocus={(e) => {
            const next = handoff.current;
            if (next) {
              e.preventDefault();
              handoff.current = null;
              next();
              return;
            }
            if (anchored) {
              e.preventDefault();
              anchored.onClose();
            }
          }}
        >
          {groups.flatMap((g, i) =>
            i === 0 ? g : [<DropdownMenuSeparator key={`sep-${g[0]?.key}`} />, ...g],
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
