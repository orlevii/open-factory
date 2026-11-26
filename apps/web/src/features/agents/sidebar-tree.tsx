import type { AgentSummary, TreeRow } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { TruncTooltip } from "@/components/agent-chip";
import { useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentMenu } from "@/features/agents/agent-menu";
import { AgentName } from "@/features/agents/agent-tree";
import {
  ancestorsOf,
  buildTree,
  indentOf,
  isExpanded,
  MAX_INDENT_LEVEL,
  pruneStored,
  railRefs,
  type TreeNode,
  visibleNodes,
  workingCounts,
} from "@/features/agents/tree-model";
import { agentIndex, useAgent } from "@/features/agents/use-agent-index";
import { type Unread, unreadCountQueryOptions, useUnreadByAgent } from "@/features/inbox/api";
import { agentsListQueryOptions } from "@/features/session/api";
import { statusLabel } from "@/features/session/status-badge";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { useLongPress } from "@/hooks/use-long-press";
import { usePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";

const newAgentIntent = sheetIntent("new-agent");

const EXPANDED_KEY = "of-tree-expanded";
const NO_STORED: Record<string, boolean> = {};
const NO_COUNTS: Record<string, number> = {};
const NO_UNREAD: Record<string, number> = {};
const NO_SET: ReadonlySet<string> = new Set();
/** The row's own left padding (`px-2`); the indent adds to it. */
const ROW_PAD_PX = 8;

function parseStored(raw: string): Record<string, boolean> | undefined {
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === "boolean"));
}

/** The list reduced to what the tree's shape depends on, as one string: a status frame leaves it
 *  equal, so the tree re-renders only when an agent is added, removed, renamed or moved. */
const shapeKeyOf = (list: AgentSummary[]) =>
  JSON.stringify(list.map((a) => [a.ref, a.handle, a.displayName, a.reportsTo]));

const parseShape = (key: string): TreeRow[] =>
  (JSON.parse(key) as [string, string, string, TreeRow["reportsTo"]][]).map(
    ([ref, handle, displayName, reportsTo]) => ({ ref, handle, displayName, reportsTo }),
  );

/** The shape key, or undefined while the live list loads. */
function useShapeKey(): string | undefined {
  return useQuery({ ...agentsListQueryOptions("exclude"), select: shapeKeyOf }).data;
}

/** Mounts its Radix tooltip only while a pointer is over it, so rows carry no tooltip root at rest.
 *  It unmounts on pointer leave, not on close: Radix closes on pointer down, and dropping the trigger
 *  then would swallow the click meant for the row's link. */
function HoverTip({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const span = (
    <span
      onPointerEnter={() => setArmed(true)}
      onPointerLeave={() => setArmed(false)}
      className={className}
    >
      {children}
    </span>
  );
  if (!armed) return span;
  return (
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

const countText = (n: number) => (n > 99 ? "99+" : String(n));
const COUNT = "text-[0.8125rem] tabular-nums text-muted-foreground";

/** The menu-button recipe of `components/ui/sidebar.tsx`, on a plain link (no `useSidebar()`). */
const ROW =
  "relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md pr-2 text-left text-sm transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-offset-[-2px] active:bg-sidebar-accent active:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground pointer-coarse:h-9";

type Via = "pointer" | "keyboard";
type Point = { x: number; y: number };

export const SidebarAgentRow = memo(function SidebarAgentRow({
  agentRef,
  level,
  hasChildren,
  expanded,
  active,
  tabbable,
  posinset,
  setsize,
  working,
  pointerToggled,
  menuOpen,
  managerName,
  onToggle,
  onMenu,
}: {
  agentRef: string;
  level: number;
  hasChildren: boolean;
  expanded: boolean;
  active: boolean;
  tabbable: boolean;
  posinset: number;
  setsize: number;
  /** Working descendants, shown only on a collapsed manager. */
  working: number;
  pointerToggled: boolean;
  menuOpen: boolean;
  /** Set past the indent cap, where the tooltip names the manager. */
  managerName: string | null;
  onToggle: (agentRef: string, via: Via) => void;
  /** Opens the tree's one AgentMenu on this row; a long-press names the point it hangs from. */
  onMenu: (agentRef: string, at?: Point) => void;
}) {
  const agent = useAgent(agentRef);
  // On touch the row's only menu path (its ⋯ shows on fine pointers only, U4 §11.2).
  const onLongPress = useCallback((at: Point) => onMenu(agentRef, at), [onMenu, agentRef]);
  const press = useLongPress(onLongPress);
  const unread = useUnreadByAgent(agentRef);
  if (!agent) return null;
  const name = agent.displayName;
  return (
    <li role="none">
      <Link
        to="/agents/$ref/chat"
        params={{ ref: agentRef }}
        role="treeitem"
        {...press}
        data-agent-row={agentRef}
        data-longpress-region=""
        data-menu-anchor=""
        data-menu-open={menuOpen || undefined}
        data-active={active || undefined}
        aria-level={level + 1}
        aria-setsize={setsize}
        aria-posinset={posinset}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-keyshortcuts="Shift+F10"
        aria-current={active ? "page" : undefined}
        tabIndex={tabbable ? 0 : -1}
        className={ROW}
        style={{ paddingLeft: ROW_PAD_PX + indentOf(level) }}
      >
        {/* The active marker is the nav row's roof tooth (DESIGN.md). */}
        {active ? (
          <span aria-hidden="true" className="of-tooth absolute top-1/2 left-0 -translate-y-1/2" />
        ) : null}
        {hasChildren ? (
          <span
            data-chevron=""
            data-toggled={pointerToggled ? "pointer" : undefined}
            aria-hidden="true"
            className={cn(
              "relative flex size-4 shrink-0 items-center justify-center text-muted-foreground after:absolute after:inset-y-[-8px] after:-inset-x-1",
              "data-[toggled=pointer]:[&>svg]:transition-transform data-[toggled=pointer]:[&>svg]:duration-150 data-[toggled=pointer]:[&>svg]:ease-(--ease-out) motion-reduce:[&>svg]:transition-none",
            )}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggle(agentRef, "pointer");
            }}
          >
            <ChevronRight className={cn("size-3.5", expanded && "rotate-90")} />
          </span>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <AgentAvatar
          agentRef={agentRef}
          template={agent.template}
          avatarVersion={agent.avatarVersion}
          color={agent.color}
          size={20}
          status={agent.status}
        />
        {/* The name and the working count share one line box that clips a second line: when the
            name at its minimum and the count no longer fit, the count wraps out of sight first. */}
        <span
          data-name-line=""
          className="flex h-5 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden"
        >
          <TruncTooltip
            text={managerName ? `${name} · reports to ${managerName}` : name}
            className="min-w-16 grow basis-16"
          >
            <AgentName agent={agent} />
          </TruncTooltip>
          <span className="sr-only">, {statusLabel(agent.status, "short")}</span>
          {working > 0 ? (
            <HoverTip
              text={`${working} working`}
              className={cn("of-row-count inline-flex shrink-0 items-center gap-0.5", COUNT)}
            >
              <span aria-hidden="true" className="of-tooth scale-75" />
              <span aria-hidden="true">{countText(working)}</span>
              <span className="sr-only">{working} working</span>
            </HoverTip>
          ) : null}
        </span>
        {unread > 0 ? (
          <>
            <span aria-hidden="true" className={cn("of-row-count shrink-0", COUNT)}>
              {countText(unread)}
            </span>
            <span className="sr-only">, {unread} unread</span>
          </>
        ) : null}
        {/* Hover (fine pointer only, by CSS) shows it in place of the counts. Not a tab stop: the
            keyboard opens the same menu with Shift+F10. A span, as the chevron is: no button in a link. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a pointer affordance; the keyboard has Shift+F10 on the row */}
        {/* biome-ignore lint/a11y/useSemanticElements: a <button> cannot nest in the row's link */}
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Actions for ${name}`}
          aria-haspopup="menu"
          data-row-more=""
          className="of-row-more size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-border hover:text-sidebar-accent-foreground"
          onPointerDown={(e) => e.preventDefault()}
          // Middle-click must not follow the enclosing link.
          onAuxClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenu(agentRef);
          }}
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </span>
      </Link>
    </li>
  );
});

const RailRow = memo(function RailRow({ agentRef, active }: { agentRef: string; active: boolean }) {
  const agent = useAgent(agentRef);
  const unread = useUnreadByAgent(agentRef);
  // The Radix tooltip mounts only while a pointer is over the link, so rail rows carry no root at
  // rest. It unmounts on leave, not on close (Radix closes on pointer down; see HoverTip).
  const [tip, setTip] = useState(false);
  if (!agent) return null;
  const status = statusLabel(agent.status, "short");
  return (
    <li>
      <Link
        to="/agents/$ref/chat"
        params={{ ref: agentRef }}
        data-active={active || undefined}
        aria-current={active ? "page" : undefined}
        onPointerEnter={() => setTip(true)}
        onPointerLeave={() => setTip(false)}
        className="relative flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent data-active:bg-sidebar-accent"
      >
        {active ? (
          <span aria-hidden="true" className="of-tooth absolute top-1/2 -left-1 -translate-y-1/2" />
        ) : null}
        <span className="relative flex">
          <AgentAvatar
            agentRef={agentRef}
            template={agent.template}
            avatarVersion={agent.avatarVersion}
            color={agent.color}
            size={20}
            status={agent.status}
          />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground"
            />
          ) : null}
        </span>
        <span className="sr-only">
          {agent.displayName}, {status}
          {unread > 0 ? `, ${unread} unread` : ""}
        </span>
        {tip ? (
          <Tooltip defaultOpen>
            {/* Over the whole link (last, so on top), so the whole link anchors the tooltip. */}
            <TooltipTrigger asChild>
              <span aria-hidden="true" className="absolute inset-0" />
            </TooltipTrigger>
            <TooltipContent side="right">{`${agent.displayName} · @${agent.handle} · ${status}`}</TooltipContent>
          </Tooltip>
        ) : null}
      </Link>
    </li>
  );
});

const selectByAgent = (d: Unread) => d.byAgent;

/** The collapsed rail's glance: mounted only while the rail is collapsed, so its selects run only then. */
function AgentRail({ nodes, activeRef }: { nodes: TreeNode[]; activeRef?: string }) {
  const byAgent =
    useQuery({ ...unreadCountQueryOptions, select: selectByAgent, refetchOnMount: false }).data ??
    NO_UNREAD;
  const select = useCallback(
    (list: AgentSummary[]) => {
      const idx = agentIndex(list);
      return railRefs(nodes, {
        active: activeRef ?? null,
        unread: (s) => byAgent[s] ?? 0,
        statusOf: (s) => idx.get(s)?.status,
      });
    },
    [nodes, activeRef, byAgent],
  );
  const agentRefs =
    useQuery({ ...agentsListQueryOptions("exclude"), refetchOnMount: false, select }).data ?? [];
  return (
    <nav aria-label="Agents">
      <ul className="flex flex-col items-center gap-1">
        {agentRefs.map((s) => (
          <RailRow key={s} agentRef={s} active={s === activeRef} />
        ))}
      </ul>
    </nav>
  );
}

function rowsIn(ul: HTMLElement | null): HTMLElement[] {
  return ul ? [...ul.querySelectorAll<HTMLElement>("[data-agent-row]")] : [];
}
const rowOf = (ul: HTMLElement | null, agentRef: string) =>
  rowsIn(ul).find((el) => el.dataset.agentRow === agentRef);

/** The live agents as the reporting tree (WAI-APG treeview, rendered flat), or the rail's glance. */
export const SidebarAgentTree = memo(function SidebarAgentTree({
  activeRef,
  collapsedRail,
}: {
  activeRef?: string;
  collapsedRail: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const shapeKey = useShapeKey();
  const shape = useMemo(() => (shapeKey ? parseShape(shapeKey) : []), [shapeKey]);
  const nodes = useMemo(() => buildTree(shape), [shape]);
  const byRef = useMemo(() => new Map(nodes.map((n) => [n.ref, n])), [nodes]);
  const names = useMemo(() => new Map(shape.map((r) => [r.ref, r.displayName])), [shape]);
  const positions = useMemo(() => {
    const siblings = new Map<string | null, string[]>();
    for (const n of nodes) {
      const list = siblings.get(n.parent);
      if (list) list.push(n.ref);
      else siblings.set(n.parent, [n.ref]);
    }
    const out = new Map<string, [number, number]>();
    for (const list of siblings.values())
      list.forEach((s, i) => {
        out.set(s, [i + 1, list.length]);
      });
    return out;
  }, [nodes]);

  const [stored, setStored] = usePref(EXPANDED_KEY, NO_STORED, parseStored, JSON.stringify);
  // Ancestors the user closed while they were revealed for this active agent; a new navigation reveals again.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(NO_SET);
  const [dismissedFor, setDismissedFor] = useState(activeRef);
  if (dismissedFor !== activeRef) {
    setDismissedFor(activeRef);
    setDismissed(NO_SET);
  }
  const revealed = useMemo<ReadonlySet<string>>(() => {
    if (!activeRef) return NO_SET;
    return new Set(ancestorsOf(nodes, activeRef).filter((s) => !dismissed.has(s)));
  }, [nodes, activeRef, dismissed]);
  const visible = useMemo(() => visibleNodes(nodes, stored, revealed), [nodes, stored, revealed]);

  const countsSelect = useCallback(
    (list: AgentSummary[]) => {
      if (collapsedRail) return NO_COUNTS;
      const idx = agentIndex(list);
      return workingCounts(
        nodes,
        (s) => idx.get(s)?.status,
        (s) => {
          const n = byRef.get(s);
          return n ? isExpanded(n, stored, revealed) : false;
        },
      );
    },
    [collapsedRail, nodes, byRef, stored, revealed],
  );
  const counts =
    useQuery({ ...agentsListQueryOptions("exclude"), refetchOnMount: false, select: countsSelect })
      .data ?? NO_COUNTS;

  const [focusRef, setFocusRef] = useState<string | null>(null);
  const [pointerToggled, setPointerToggled] = useState<string | null>(null);
  // One AgentMenu for the tree, opened on the row named here. The agentRef outlives the close so the
  // menu keeps its content for the exit animation.
  const [menu, setMenu] = useState<{ agentRef: string | null; open: boolean; at?: Point }>({
    agentRef: null,
    open: false,
  });
  const menuRef = menu.open ? menu.agentRef : null;
  const openMenu = useCallback(
    (agentRef: string, at?: Point) => setMenu({ agentRef, open: true, at }),
    [],
  );

  // Read by the stable toggle, so rows never see a new callback.
  const latest = useRef({ nodes, byRef, stored, revealed, setStored });
  useLayoutEffect(() => {
    latest.current = { nodes, byRef, stored, revealed, setStored };
  });
  const toggle = useCallback((agentRef: string, via: Via) => {
    const { nodes, byRef, stored, revealed, setStored } = latest.current;
    const node = byRef.get(agentRef);
    if (!node?.hasChildren) return;
    const next = !isExpanded(node, stored, revealed);
    if (!next && revealed.has(agentRef)) setDismissed((d) => new Set([...d, agentRef]));
    setStored(pruneStored({ ...stored, [agentRef]: next }, new Set(nodes.map((n) => n.ref))));
    setPointerToggled(via === "pointer" ? agentRef : null);
  }, []);

  const ulRef = useRef<HTMLUListElement>(null);
  const loaded = shapeKey !== undefined;
  // The menu's agent left the list: the tree's own state closes (state only, no effect), so the row
  // drops its selected look and the agent coming back never reopens the menu by itself.
  if (menu.open && menu.agentRef && loaded && !byRef.has(menu.agentRef))
    setMenu((m) => ({ ...m, open: false }));
  useEffect(() => {
    if (!activeRef || !loaded) return;
    const id = requestAnimationFrame(() =>
      rowOf(ulRef.current, activeRef)?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, [activeRef, loaded]);

  if (!loaded)
    return (
      <div aria-hidden="true" className="flex flex-col">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  if (nodes.length === 0)
    return collapsedRail ? null : (
      <div className="flex flex-col gap-1 px-2 py-1.5 text-sm">
        <p className="text-muted-foreground">No agents yet.</p>
        <button
          type="button"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            openSheet({ kind: "new-agent" });
          }}
          {...newAgentIntent}
          className="self-start underline-offset-4 hover:underline"
        >
          New agent
        </button>
      </div>
    );
  if (collapsedRail) return <AgentRail nodes={nodes} activeRef={activeRef} />;

  const visibleRefs = new Set(visible.map((n) => n.ref));
  const tabStop =
    focusRef && visibleRefs.has(focusRef)
      ? focusRef
      : activeRef && visibleRefs.has(activeRef)
        ? activeRef
        : visible[0]?.ref;

  // A row that has gone (its agent left the list with the menu open) hands focus to the tab stop.
  const focusRow = (agentRef: string) => {
    const el =
      rowOf(ulRef.current, agentRef) ?? (tabStop ? rowOf(ulRef.current, tabStop) : undefined);
    if (!el) return;
    setFocusRef(el.dataset.agentRow ?? agentRef);
    el.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const agentRef = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-row]")?.dataset
      .agentRow;
    const i = visible.findIndex((n) => n.ref === agentRef);
    const n = visible[i];
    if (!agentRef || !n) return;
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenu(agentRef);
      return;
    }
    const open = n.hasChildren && isExpanded(n, stored, revealed);
    let target: string | null | undefined;
    switch (e.key) {
      case "ArrowDown":
        target = visible[i + 1]?.ref;
        break;
      case "ArrowUp":
        target = visible[i - 1]?.ref;
        break;
      case "Home":
        target = visible[0]?.ref;
        break;
      case "End":
        target = visible.at(-1)?.ref;
        break;
      case "ArrowRight":
        if (open) target = visible[i + 1]?.ref;
        else if (n.hasChildren) toggle(agentRef, "keyboard");
        break;
      case "ArrowLeft":
        if (open) toggle(agentRef, "keyboard");
        else target = n.parent;
        break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !/\S/.test(e.key)) return;
        const ch = e.key.toLowerCase();
        const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
        target = order.find((v) => names.get(v.ref)?.toLowerCase().startsWith(ch))?.ref;
      }
    }
    e.preventDefault();
    if (target) focusRow(target);
  };

  // One delegated handler: following a row closes the mobile drawer (the chevron stops propagation).
  const onClick = (e: MouseEvent<HTMLUListElement>) => {
    if (isMobile && (e.target as Element).closest("[data-agent-row]")) setOpenMobile(false);
  };

  return (
    <nav aria-label="Agents">
      <ul
        ref={ulRef}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the APG treeview, a flat list of treeitem links
        role="tree"
        aria-label="Agents"
        className="flex flex-col"
        onKeyDown={onKeyDown}
        onClick={onClick}
        onFocus={(e) => {
          const s = (e.target as HTMLElement).dataset.agentRow;
          if (s) setFocusRef(s);
        }}
      >
        {visible.map((n) => {
          const [posinset, setsize] = positions.get(n.ref) ?? [1, 1];
          return (
            <SidebarAgentRow
              key={n.ref}
              agentRef={n.ref}
              level={n.level}
              hasChildren={n.hasChildren}
              expanded={n.hasChildren && isExpanded(n, stored, revealed)}
              active={n.ref === activeRef}
              tabbable={n.ref === tabStop}
              posinset={posinset}
              setsize={setsize}
              working={counts[n.ref] ?? 0}
              pointerToggled={n.ref === pointerToggled}
              menuOpen={n.ref === menuRef}
              managerName={
                n.level > MAX_INDENT_LEVEL && n.parent ? (names.get(n.parent) ?? null) : null
              }
              onToggle={toggle}
              onMenu={openMenu}
            />
          );
        })}
      </ul>
      {menu.agentRef ? (
        <TreeAgentMenu
          agentRef={menu.agentRef}
          open={menu.open}
          onOpenChange={(open) => setMenu((m) => ({ ...m, open }))}
          anchor={rowOf(ulRef.current, menu.agentRef) ?? null}
          point={menu.at}
          onClose={focusRow}
        />
      ) : null}
    </nav>
  );
});

/** The tree's one AgentMenu. It subscribes to its agent itself, so that agent's status frames
 *  re-render the menu only, not the tree (the agentRef outlives the close for the exit animation).
 *  When the agent leaves the list (terminated, archived, deleted) the menu closes: its open state is
 *  derived here, and the last copy of the agent keeps its content through the exit. */
function TreeAgentMenu({
  agentRef,
  open,
  onOpenChange,
  anchor,
  point,
  onClose,
}: {
  agentRef: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: HTMLElement | null;
  /** A long-press's point: the dropdown hangs from it. */
  point?: Point;
  onClose: (agentRef: string) => void;
}) {
  const agent = useAgent(agentRef);
  const [last, setLast] = useState(agent);
  if (agent && agent !== last) setLast(agent);
  const shown = agent ?? (last?.ref === agentRef ? last : undefined);
  if (!shown) return null;
  const present = agent !== undefined && agent.status !== "terminated";
  return (
    <AgentMenu
      agent={shown}
      context="sidebar"
      anchored={{
        open: open && present,
        onOpenChange,
        anchor,
        point,
        onClose: () => onClose(agentRef),
      }}
    />
  );
}
