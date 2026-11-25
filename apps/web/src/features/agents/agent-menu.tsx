import type { AgentSummary } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { type ReactElement, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuSeparator,
  AdaptiveMenuShortcut,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  archiveAgent,
  resetPersona,
  restartAgentNow,
  restoreAgent,
} from "@/features/agents/lifecycle";
import type { AgentView } from "@/features/agents/view-memory";
import { viewSwitchTarget } from "@/features/agents/view-switch";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { cn } from "@/lib/utils";
import { CompactPopover } from "../session/compact-popover";
import type { StopCrons } from "../session/stop-crons";
import { TerminateButton } from "../session/terminate-button";

/** Statuses with a live session to restart (an errored agent has the header's Restart). */
const RESTARTABLE: ReadonlySet<string> = new Set(["working", "idle", "rate_limited"]);
const newTaskIntent = sheetIntent("new-task");
const newScheduleIntent = sheetIntent("new-schedule");

/**
 * The one actions menu for an agent (U2 §8.4, U4 §6.5), in the session header, on a sidebar row and
 * on an Agents page row. Grouped: New task, New schedule · Edit, Configure, Usage, Open tasks, Agent details,
 * Compact…, Stop crons… · Reset persona…, Archive…, Restore, Terminate….
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
  viewSwitch,
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
  /** The header is crowded: its view switch moves here, to the top of the menu. The current view. */
  viewSwitch?: AgentView;
  /** One shared instance for a list (the sidebar tree): controlled, with no ⋯ of its own. It opens
   *  below the right edge of `anchor` (the row the caller names) and hands focus back with `onClose`. */
  anchored?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    anchor: HTMLElement | null;
    /** A long-press's point (U4 §11.2): a dropdown hangs from it rather than the row. */
    point?: { x: number; y: number };
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
  const [resetOpen, setResetOpen] = useState(false);
  // Mounted at the first opening and kept, so its close animation plays; a list of rows mounts none until asked.
  const [resetMounted, setResetMounted] = useState(false);
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
  // Archived agents too: their configuration stays editable and applies when restored (I2 §12.4).
  const canConfigure = !spawned && !terminated && !endedInList;
  // A live session to restart: not hibernated, queued or errored (an errored agent has the header's Restart).
  const canRestart = RESTARTABLE.has(agent.status) && !archived;
  const canStopCrons = session && stop !== undefined && agent.crons.length > 0;
  const canTerminate = session && spawned && live;
  const canResetPersona = !spawned && !terminated;
  const canArchive = !spawned && live;
  const canRestore = archived && !terminated && !endedInList;
  const editIntent = useMemo(() => sheetIntent("edit-agent", { kind: "edit-agent", slug }), [slug]);

  // An item that opens a sheet hands over once the menu has gone, as Compact… does. Focus goes back
  // to the ⋯ (or the row) first, so the sheet returns it there when it closes.
  const openAfterClose = (open: () => void) => {
    handoff.current = () => {
      if (anchored) anchored.onClose();
      else trigger.current?.focus();
      open();
    };
  };

  const create: ReactElement[] = live
    ? [
        <AdaptiveMenuItem
          key="new-task"
          opensOverlay
          {...newTaskIntent}
          onSelect={() => openAfterClose(() => openSheet({ kind: "new-task", assignee: slug }))}
        >
          New task
        </AdaptiveMenuItem>,
        <AdaptiveMenuItem
          key="new-schedule"
          opensOverlay
          {...newScheduleIntent}
          onSelect={() => openAfterClose(() => openSheet({ kind: "new-schedule", target: slug }))}
        >
          New schedule
        </AdaptiveMenuItem>,
      ]
    : [];
  const views: ReactElement[] = [];
  if (context === "sidebar")
    views.push(
      <AdaptiveMenuItem key="open" asChild>
        <Link to="/agents/$slug/session" params={{ slug }}>
          Open session
        </Link>
      </AdaptiveMenuItem>,
    );
  if (canEdit)
    views.push(
      <AdaptiveMenuItem
        key="edit"
        opensOverlay
        {...editIntent}
        onSelect={() => openAfterClose(() => openSheet({ kind: "edit-agent", slug }))}
      >
        Edit
      </AdaptiveMenuItem>,
    );
  if (canConfigure)
    views.push(
      <AdaptiveMenuItem key="configure" asChild>
        <Link to="/agents/$slug/config" params={{ slug }}>
          Configure
        </Link>
      </AdaptiveMenuItem>,
    );
  views.push(
    <AdaptiveMenuItem key="usage" asChild>
      <Link to="/agents/$slug/usage" params={{ slug }}>
        Usage
      </Link>
    </AdaptiveMenuItem>,
    <AdaptiveMenuItem key="tasks" asChild>
      <Link to="/tasks" search={{ assignee: slug }}>
        Open tasks
      </Link>
    </AdaptiveMenuItem>,
  );
  if (session)
    views.push(
      <AdaptiveMenuItem
        key="details"
        opensOverlay={detailsTakeFocus}
        onSelect={() => {
          if (!detailsTakeFocus) return onOpenDetails?.();
          handoff.current = () => onOpenDetails?.();
        }}
      >
        Agent details
        <AdaptiveMenuShortcut>
          <Kbd keys={["]"]} />
        </AdaptiveMenuShortcut>
      </AdaptiveMenuItem>,
    );
  if (canCompact)
    views.push(
      <AdaptiveMenuItem
        key="compact"
        opensOverlay
        onSelect={() => {
          handoff.current = () => setCompactOpen(true);
        }}
      >
        Compact…
      </AdaptiveMenuItem>,
    );
  if (canStopCrons)
    views.push(
      <AdaptiveMenuItem
        key="stop-crons"
        opensOverlay
        onSelect={() => {
          // The confirmation places focus and returns it to ⋯ itself: the menu's close leaves it be.
          handoff.current = () => {};
          stop.openConfirm(trigger);
        }}
      >
        Stop crons…
      </AdaptiveMenuItem>,
    );
  if (canRestart)
    views.push(
      <AdaptiveMenuItem key="restart" onSelect={() => void restartAgentNow(slug, qc)}>
        Restart now
      </AdaptiveMenuItem>,
    );
  const lifecycle: ReactElement[] = [];
  if (canResetPersona)
    lifecycle.push(
      <AdaptiveMenuItem
        key="reset-persona"
        opensOverlay
        onSelect={() => {
          handoff.current = () => {}; // as Stop crons…: the confirmation owns focus
          setResetMounted(true);
          setResetOpen(true);
        }}
      >
        Reset persona…
      </AdaptiveMenuItem>,
    );
  if (canArchive)
    lifecycle.push(
      <AdaptiveMenuItem
        key="archive"
        variant="destructive"
        onSelect={() => void archiveAgent(agent, qc, { onChanged: onLifecycle })}
      >
        Archive…
      </AdaptiveMenuItem>,
    );
  if (canRestore)
    lifecycle.push(
      <AdaptiveMenuItem
        key="restore"
        onSelect={() => void restoreAgent(slug, qc, { onChanged: onLifecycle })}
      >
        Restore
      </AdaptiveMenuItem>,
    );
  if (canTerminate)
    lifecycle.push(
      <AdaptiveMenuItem
        key="terminate"
        variant="destructive"
        opensOverlay
        onSelect={() => {
          handoff.current = () => {}; // as Stop crons…: the confirmation owns focus
          setTerminateOpen(true);
        }}
      >
        Terminate…
      </AdaptiveMenuItem>,
    );
  const nav: ReactElement[] = [];
  if (viewSwitch) {
    const target = viewSwitchTarget(viewSwitch);
    nav.push(
      <AdaptiveMenuItem key="view" asChild>
        <Link to={target.to} params={{ slug }}>
          {target.opens}
        </Link>
      </AdaptiveMenuItem>,
    );
  }
  const groups = [nav, create, views, lifecycle].filter((g) => g.length > 0);

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
      <AdaptiveMenu
        open={anchored?.open}
        onOpenChange={anchored?.onOpenChange}
        title={agent.displayName}
        anchor={anchored?.point}
      >
        <AdaptiveMenuTrigger asChild>
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
        </AdaptiveMenuTrigger>
        <AdaptiveMenuContent
          align={anchored?.point ? "start" : "end"}
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
            i === 0 ? g : [<AdaptiveMenuSeparator key={`sep-${g[0]?.key}`} />, ...g],
          )}
        </AdaptiveMenuContent>
      </AdaptiveMenu>
      {canCompact && (
        <CompactPopover
          slug={slug}
          open={compactOpen}
          onOpenChange={setCompactOpen}
          anchor={trigger}
        />
      )}
      {canResetPersona && resetMounted && (
        <ConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          title="Reset persona?"
          body={`Replace @${slug}'s AGENTS.md with the template's. The current file is saved in state/agents/${slug}/persona/.`}
          confirmLabel="Reset persona"
          pendingLabel="Resetting…"
          onConfirm={() => resetPersona(slug, qc, agent.template)}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (anchored) anchored.onClose();
            else trigger.current?.focus();
          }}
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
