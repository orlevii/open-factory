import type { AgentSummary, TreeRow } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
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
import { AgentName } from "@/features/agents/agent-tree";
import {
  ancestorsOf,
  buildTree,
  indentOf,
  isExpanded,
  MAX_INDENT_LEVEL,
  pruneStored,
  railSlugs,
  type TreeNode,
  visibleNodes,
  workingCounts,
} from "@/features/agents/tree-model";
import { agentIndex, useAgent } from "@/features/agents/use-agent-index";
import { type Unread, unreadCountQueryOptions, useUnreadByAgent } from "@/features/inbox/api";
import { agentsListQueryOptions } from "@/features/session/api";
import { statusLabel } from "@/features/session/status-badge";
import { usePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";

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
  JSON.stringify(list.map((a) => [a.slug, a.displayName, a.reportsTo]));

const parseShape = (key: string): TreeRow[] =>
  (JSON.parse(key) as [string, string, string | null][]).map(([slug, displayName, reportsTo]) => ({
    slug,
    displayName,
    reportsTo,
  }));

/** The shape key, or undefined while the live list loads. */
function useShapeKey(): string | undefined {
  return useQuery({ ...agentsListQueryOptions("exclude"), select: shapeKeyOf }).data;
}

/** The live agents' tree shape. Identity-stable across status frames. */
export function useAgentTreeShape(): TreeNode[] {
  const key = useShapeKey();
  return useMemo(() => (key ? buildTree(parseShape(key)) : []), [key]);
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

export const SidebarAgentRow = memo(function SidebarAgentRow({
  slug,
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
}: {
  slug: string;
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
  onToggle: (slug: string, via: Via) => void;
}) {
  const agent = useAgent(slug);
  const unread = useUnreadByAgent(slug);
  if (!agent) return null;
  const name = agent.displayName;
  return (
    <li role="none">
      <Link
        to="/agents/$slug"
        params={{ slug }}
        role="treeitem"
        data-agent-row={slug}
        data-menu-anchor=""
        data-menu-open={menuOpen || undefined}
        data-active={active || undefined}
        aria-level={level + 1}
        aria-setsize={setsize}
        aria-posinset={posinset}
        aria-expanded={hasChildren ? expanded : undefined}
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
              onToggle(slug, "pointer");
            }}
          >
            <ChevronRight className={cn("size-3.5", expanded && "rotate-90")} />
          </span>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <AgentAvatar
          slug={slug}
          template={agent.template}
          avatarVersion={agent.avatarVersion}
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
              className={cn("inline-flex shrink-0 items-center gap-0.5", COUNT)}
            >
              <span aria-hidden="true" className="of-tooth scale-75" />
              <span aria-hidden="true">{countText(working)}</span>
              <span className="sr-only">{working} working</span>
            </HoverTip>
          ) : null}
        </span>
        {unread > 0 ? (
          <>
            <span aria-hidden="true" className={cn("shrink-0", COUNT)}>
              {countText(unread)}
            </span>
            <span className="sr-only">, {unread} unread</span>
          </>
        ) : null}
      </Link>
    </li>
  );
});

const RailRow = memo(function RailRow({ slug, active }: { slug: string; active: boolean }) {
  const agent = useAgent(slug);
  const unread = useUnreadByAgent(slug);
  // The Radix tooltip mounts only while a pointer is over the link, so rail rows carry no root at
  // rest. It unmounts on leave, not on close (Radix closes on pointer down; see HoverTip).
  const [tip, setTip] = useState(false);
  if (!agent) return null;
  const status = statusLabel(agent.status, "short");
  return (
    <li>
      <Link
        to="/agents/$slug"
        params={{ slug }}
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
            slug={slug}
            template={agent.template}
            avatarVersion={agent.avatarVersion}
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
            <TooltipContent side="right">{`${agent.displayName} · @${slug} · ${status}`}</TooltipContent>
          </Tooltip>
        ) : null}
      </Link>
    </li>
  );
});

const selectByAgent = (d: Unread) => d.byAgent;

/** The collapsed rail's glance: mounted only while the rail is collapsed, so its selects run only then. */
function AgentRail({ nodes, activeSlug }: { nodes: TreeNode[]; activeSlug?: string }) {
  const byAgent =
    useQuery({ ...unreadCountQueryOptions, select: selectByAgent, refetchOnMount: false }).data ??
    NO_UNREAD;
  const select = useCallback(
    (list: AgentSummary[]) => {
      const idx = agentIndex(list);
      return railSlugs(nodes, {
        active: activeSlug ?? null,
        unread: (s) => byAgent[s] ?? 0,
        statusOf: (s) => idx.get(s)?.status,
      });
    },
    [nodes, activeSlug, byAgent],
  );
  const slugs =
    useQuery({ ...agentsListQueryOptions("exclude"), refetchOnMount: false, select }).data ?? [];
  return (
    <nav aria-label="Agents">
      <ul className="flex flex-col items-center gap-1">
        {slugs.map((s) => (
          <RailRow key={s} slug={s} active={s === activeSlug} />
        ))}
      </ul>
    </nav>
  );
}

function rowsIn(ul: HTMLElement | null): HTMLElement[] {
  return ul ? [...ul.querySelectorAll<HTMLElement>("[data-agent-row]")] : [];
}
const rowOf = (ul: HTMLElement | null, slug: string) =>
  rowsIn(ul).find((el) => el.dataset.agentRow === slug);

/** The live agents as the reporting tree (WAI-APG treeview, rendered flat), or the rail's glance. */
export const SidebarAgentTree = memo(function SidebarAgentTree({
  activeSlug,
  collapsedRail,
}: {
  activeSlug?: string;
  collapsedRail: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const shapeKey = useShapeKey();
  const shape = useMemo(() => (shapeKey ? parseShape(shapeKey) : []), [shapeKey]);
  const nodes = useMemo(() => buildTree(shape), [shape]);
  const bySlug = useMemo(() => new Map(nodes.map((n) => [n.slug, n])), [nodes]);
  const names = useMemo(() => new Map(shape.map((r) => [r.slug, r.displayName])), [shape]);
  const positions = useMemo(() => {
    const siblings = new Map<string | null, string[]>();
    for (const n of nodes) {
      const list = siblings.get(n.parent);
      if (list) list.push(n.slug);
      else siblings.set(n.parent, [n.slug]);
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
  const [dismissedFor, setDismissedFor] = useState(activeSlug);
  if (dismissedFor !== activeSlug) {
    setDismissedFor(activeSlug);
    setDismissed(NO_SET);
  }
  const revealed = useMemo<ReadonlySet<string>>(() => {
    if (!activeSlug) return NO_SET;
    return new Set(ancestorsOf(nodes, activeSlug).filter((s) => !dismissed.has(s)));
  }, [nodes, activeSlug, dismissed]);
  const visible = useMemo(() => visibleNodes(nodes, stored, revealed), [nodes, stored, revealed]);

  const countsSelect = useCallback(
    (list: AgentSummary[]) => {
      if (collapsedRail) return NO_COUNTS;
      const idx = agentIndex(list);
      return workingCounts(
        nodes,
        (s) => idx.get(s)?.status,
        (s) => {
          const n = bySlug.get(s);
          return n ? isExpanded(n, stored, revealed) : false;
        },
      );
    },
    [collapsedRail, nodes, bySlug, stored, revealed],
  );
  const counts =
    useQuery({ ...agentsListQueryOptions("exclude"), refetchOnMount: false, select: countsSelect })
      .data ?? NO_COUNTS;

  const [focusSlug, setFocusSlug] = useState<string | null>(null);
  const [pointerToggled, setPointerToggled] = useState<string | null>(null);
  // AgentMenu (PR2) is one instance for the tree, opened on the row named here.
  const [menuSlug] = useState<string | null>(null);

  // Read by the stable toggle, so rows never see a new callback.
  const latest = useRef({ nodes, bySlug, stored, revealed, setStored });
  useLayoutEffect(() => {
    latest.current = { nodes, bySlug, stored, revealed, setStored };
  });
  const toggle = useCallback((slug: string, via: Via) => {
    const { nodes, bySlug, stored, revealed, setStored } = latest.current;
    const node = bySlug.get(slug);
    if (!node?.hasChildren) return;
    const next = !isExpanded(node, stored, revealed);
    if (!next && revealed.has(slug)) setDismissed((d) => new Set([...d, slug]));
    setStored(pruneStored({ ...stored, [slug]: next }, new Set(nodes.map((n) => n.slug))));
    setPointerToggled(via === "pointer" ? slug : null);
  }, []);

  const ulRef = useRef<HTMLUListElement>(null);
  const loaded = shapeKey !== undefined;
  useEffect(() => {
    if (!activeSlug || !loaded) return;
    const id = requestAnimationFrame(() =>
      rowOf(ulRef.current, activeSlug)?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, [activeSlug, loaded]);

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
        <Link
          to="/agents/new"
          onClick={() => isMobile && setOpenMobile(false)}
          className="underline-offset-4 hover:underline"
        >
          New agent
        </Link>
      </div>
    );
  if (collapsedRail) return <AgentRail nodes={nodes} activeSlug={activeSlug} />;

  const visibleSlugs = new Set(visible.map((n) => n.slug));
  const tabStop =
    focusSlug && visibleSlugs.has(focusSlug)
      ? focusSlug
      : activeSlug && visibleSlugs.has(activeSlug)
        ? activeSlug
        : visible[0]?.slug;

  const focusRow = (slug: string) => {
    setFocusSlug(slug);
    rowOf(ulRef.current, slug)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const slug = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-row]")?.dataset
      .agentRow;
    const i = visible.findIndex((n) => n.slug === slug);
    const n = visible[i];
    if (!slug || !n) return;
    const open = n.hasChildren && isExpanded(n, stored, revealed);
    let target: string | null | undefined;
    switch (e.key) {
      case "ArrowDown":
        target = visible[i + 1]?.slug;
        break;
      case "ArrowUp":
        target = visible[i - 1]?.slug;
        break;
      case "Home":
        target = visible[0]?.slug;
        break;
      case "End":
        target = visible.at(-1)?.slug;
        break;
      case "ArrowRight":
        if (open) target = visible[i + 1]?.slug;
        else if (n.hasChildren) toggle(slug, "keyboard");
        break;
      case "ArrowLeft":
        if (open) toggle(slug, "keyboard");
        else target = n.parent;
        break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !/\S/.test(e.key)) return;
        const ch = e.key.toLowerCase();
        const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
        target = order.find((v) => names.get(v.slug)?.toLowerCase().startsWith(ch))?.slug;
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
          if (s) setFocusSlug(s);
        }}
      >
        {visible.map((n) => {
          const [posinset, setsize] = positions.get(n.slug) ?? [1, 1];
          return (
            <SidebarAgentRow
              key={n.slug}
              slug={n.slug}
              level={n.level}
              hasChildren={n.hasChildren}
              expanded={n.hasChildren && isExpanded(n, stored, revealed)}
              active={n.slug === activeSlug}
              tabbable={n.slug === tabStop}
              posinset={posinset}
              setsize={setsize}
              working={counts[n.slug] ?? 0}
              pointerToggled={n.slug === pointerToggled}
              menuOpen={n.slug === menuSlug}
              managerName={
                n.level > MAX_INDENT_LEVEL && n.parent ? (names.get(n.parent) ?? null) : null
              }
              onToggle={toggle}
            />
          );
        })}
      </ul>
    </nav>
  );
});
