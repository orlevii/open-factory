import type { AgentSummary, AgentUsageRow } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, RotateCw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { AgentMenu } from "@/features/agents/agent-menu";
import { formatDay } from "@/features/session/format";
import { resetPhrase, StatusBadge } from "@/features/session/status-badge";
import { UnsandboxedBadge } from "@/features/session/unsandboxed-badge";
import { formatCost } from "@/features/usage/format";
import { useLongPress } from "@/hooks/use-long-press";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/** The tree draws only agent managers: a human manager makes a root. */
const managerSlug = (a: AgentSummary) => (a.reportsTo.kind === "agent" ? a.reportsTo.handle : "");

/** Indentation per tree level inside the name cell; capped below `md` so names keep room. */
const INDENT = 20;

type Point = { x: number; y: number };
const DESKTOP_DEPTH_CAP = 8;
const MOBILE_DEPTH_CAP = 3;

const slugStem = (s: string) => s.replace(/-[a-z0-9]{4}$/, "");

/** For each row, which ancestor levels (1..level-1) have a later sibling, so their vertical line
 *  continues through it. One backward pass: `later[j]` is whether a level-j row follows with no
 *  shallower row between. */
function continuations(levels: number[]): boolean[][] {
  const later: boolean[] = [];
  const out: boolean[][] = new Array(levels.length);
  for (let i = levels.length - 1; i >= 0; i--) {
    const l = levels[i] as number;
    out[i] = Array.from({ length: Math.max(l - 1, 0) }, (_, k) => later[k + 1] === true);
    later[l] = true;
    later.length = l + 1;
  }
  return out;
}

/** At most one muted note after the name (S5 UI design §4), by priority. Plain text: no interactive
 *  elements inside the row link. */
function agentNote(a: AgentSummary): string | null {
  if (a.runtimeDisabled) return "Local runtime disabled";
  if (a.status === "rate_limited") {
    const reset = resetPhrase(a);
    if (reset) return reset.bare;
  }
  const tasks = a.waitingOn.tasks.length;
  if (tasks > 0) return `Waiting on ${tasks} ${tasks === 1 ? "task" : "tasks"}`;
  const crons = a.waitingOn.crons;
  if (crons > 0) return crons === 1 ? "1 cron" : `${crons} crons`;
  return null;
}

/** An ended agent's note (S7 UI design §3): when it ended and what became of its workspace. */
function endedNote(a: AgentSummary, now: Date): string | null {
  const day = (iso: string) => formatDay(new Date(iso), now);
  if (a.terminatedAt) {
    const ended = `Terminated ${day(a.terminatedAt)}`;
    if (a.workspaceDeletedAt) return `${ended} · workspace deleted`;
    if (a.workspacePinned) return `${ended} · workspace pinned`;
    // Past the grace the sweep deletes it within minutes (a failing deletion is retried): a day in
    // the past would read as a broken promise.
    if (a.workspaceGraceEndsAt)
      return Date.parse(a.workspaceGraceEndsAt) <= now.getTime()
        ? `${ended} · workspace due for deletion`
        : `${ended} · workspace kept until ${day(a.workspaceGraceEndsAt)}`;
    return ended;
  }
  return a.archivedAt ? `Archived ${day(a.archivedAt)}` : null;
}

/** The display name; a spawned agent's " · ab12" tail never truncates (S7 UI design §3), since it is
 *  what tells siblings apart: the head gives way first. */
export function AgentName({ agent }: { agent: Pick<AgentSummary, "displayName" | "kind"> }) {
  const i = agent.kind === "ephemeral" ? agent.displayName.lastIndexOf(" · ") : -1;
  if (i <= 0) return <span className="block min-w-0 truncate">{agent.displayName}</span>;
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="min-w-0 truncate">
        {agent.displayName.slice(0, i)}
      </span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">
        {" "}
        {agent.displayName.slice(i + 1)}
      </span>
      <span className="sr-only">{agent.displayName}</span>
    </span>
  );
}

/** The 7-day figure of a row: a persistent agent's total includes what it spawned; a spawned agent
 *  and every row of the flat Ended list show their own. */
function usageCell(row: AgentUsageRow | undefined, own: boolean) {
  const lead = "Estimated cost, last 7 days";
  // The response holds only agents with turns in the window (plus live persistent ones): a loaded
  // response without this agent means no turns.
  if (!row) return { text: "—", sr: `${lead}: none` };
  const t = own || row.kind === "ephemeral" ? row.own : row.total;
  const text = formatCost(t.costUsd, t.turns);
  const sr =
    t.turns === 0
      ? `${lead}: none`
      : !own && row.kind === "persistent" && row.spawned && row.spawned.turns > 0
        ? `${lead}: ${text} (own ${formatCost(row.own.costUsd, row.own.turns)}, spawned ${formatCost(row.spawned.costUsd, row.spawned.turns)})`
        : `${lead}: ${text}`;
  return { text, sr };
}

/** One row of the tree. Memoized: a status frame replaces one agent object, so only its row renders
 *  again; every other prop is a primitive or kept stable by the tree. */
const AgentTreeRow = memo(function AgentTreeRow({
  agent: a,
  level,
  cap,
  continues,
  managerName,
  usageRow,
  usageLoaded,
  flat,
  focused,
  now,
  menuOpen,
  onMenu,
}: {
  agent: AgentSummary;
  level: number;
  cap: number;
  continues: boolean[];
  managerName: string | undefined;
  usageRow: AgentUsageRow | undefined;
  usageLoaded: boolean;
  flat: boolean;
  focused: boolean;
  now: Date;
  menuOpen: boolean;
  onMenu: (slug: string, anchor?: HTMLElement, at?: Point) => void;
}) {
  // A long-press on the row opens the list's one menu at the press point (U4 §11.2).
  const onLongPress = useCallback((at: Point) => onMenu(a.slug, undefined, at), [onMenu, a.slug]);
  const press = useLongPress(onLongPress);
  const depth = Math.min(level, cap);
  const beyond = level > cap;
  const ended = a.archivedAt !== null || a.status === "terminated";
  // Empty while usage is loading or failed; a dash once loaded without a row for this agent.
  const cost = usageLoaded ? usageCell(usageRow, flat) : null;
  const note = ended ? endedNote(a, now) : agentNote(a);
  return (
    <li className="flex items-center">
      <Link
        to="/agents/$slug/chat"
        params={{ slug: a.slug }}
        {...press}
        data-longpress-region=""
        data-agent-link={a.slug}
        data-focused={focused || undefined}
        data-menu-open={menuOpen || undefined}
        className={cn(
          "of-row flex min-w-0 flex-1 data-focused:bg-accent data-menu-open:bg-accent min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm",
          // md: two lines (status, name, cost; then slug, template, runtime under the name), so the
          // name keeps 8rem. The full columns need about 54rem of the tree itself, which a 1024px
          // window with the sidebar open doesn't give, so they key on the tree's width, not the window.
          "md:grid md:grid-cols-[7rem_minmax(8rem,1fr)_4rem]",
          "@min-[54rem]:grid-cols-[7rem_minmax(0,1fr)_10rem_10rem_7rem_4rem] @min-[54rem]:py-0",
        )}
      >
        {/* Below md the column is the status shape alone, its label sr-only (U4 §11.6, #102): a 7rem
            column left a deep row's name cell about 8px at 320, so its avatar ran under the ⋯. */}
        <span data-status-cell className="flex shrink-0 items-center gap-1.5 md:w-28">
          {a.archivedAt && a.status !== "terminated" ? (
            <span className="inline-flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
              {/* The empty dot slot keeps the label aligned with the live statuses. */}
              <span aria-hidden="true" className="size-3" />
              <span className="max-md:sr-only">Archived</span>
            </span>
          ) : (
            <StatusBadge status={a.status} size="short" labelClassName="max-md:sr-only" />
          )}
          {a.restartPending && !ended && (
            <>
              <RotateCw aria-hidden="true" className="size-3 text-muted-foreground" />
              <span className="sr-only">restart pending</span>
            </>
          )}
        </span>
        <span
          data-depth={level}
          className="relative min-w-0 flex-1"
          style={{ paddingLeft: `${depth * INDENT}px` }}
        >
          {/* Ancestor lines, one per level whose subtree continues past this row; they run
                through the row's padding so they read as one rule down the list. */}
          {continues.map(
            (more, k) =>
              more &&
              k + 1 <= cap && (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the level is the identity
                  key={k}
                  data-tree-line
                  aria-hidden="true"
                  className="absolute -top-2 -bottom-2 w-px bg-border"
                  style={{ left: `${(k + 1) * INDENT + 2}px` }}
                />
              ),
          )}
          <span
            className={cn(
              "relative flex min-w-0 items-baseline gap-2",
              // The └ elbow: a 1px rule corner drawn just before a nested name.
              level > 0 &&
                !beyond &&
                "pl-3.5 before:absolute before:top-0 before:left-0.5 before:h-[0.6875rem] before:w-2 before:border-b before:border-l before:border-border",
            )}
          >
            {beyond && (
              // A no-break space and no shrinking: the marker never wraps under the elbow.
              <span
                aria-hidden="true"
                className="shrink-0 whitespace-nowrap text-[0.8125rem] text-muted-foreground tabular-nums"
              >
                {`└\u00a0${level}`}
              </span>
            )}
            {/* The full name for a name cut to a few characters on a phone (U4 §11.6). */}
            <span title={a.displayName} className="flex min-w-0">
              <AgentChip agent={a} showSlug />
            </span>
            {/* Inline, not a second line, so live updates never change the row height. It
                  gives way (truncates) before the name does. */}
            {note && (
              <span
                data-agent-note
                className="min-w-0 shrink-[1000] truncate text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
              >
                {note}
              </span>
            )}
          </span>
          {a.reportsTo.kind === "agent" && (
            <span className="sr-only">
              {" "}
              {managerName
                ? `reports to ${managerName} (@${a.reportsTo.handle})`
                : `reports to @${a.reportsTo.handle}`}
            </span>
          )}
        </span>
        {/* A second line below md and in the two-line grid; grid cells in the full one. */}
        <span className="flex min-w-0 max-w-full basis-full flex-wrap items-center gap-x-4 gap-y-0.5 md:col-start-2 @min-[54rem]:contents">
          <span className="min-w-0 truncate font-mono text-[0.8125rem] text-muted-foreground">
            {a.template !== slugStem(a.slug) ? a.template : null}
          </span>
          <span className="md:justify-self-end">
            {a.runtime === "local" ? <UnsandboxedBadge /> : null}
          </span>
        </span>
        {cost && (
          <span className="hidden text-right text-[0.8125rem] text-muted-foreground tabular-nums md:col-start-3 md:row-start-1 md:block @min-[54rem]:col-start-6">
            <span aria-hidden="true">{cost.text}</span>
            <span className="sr-only">{cost.sr}</span>
          </span>
        )}
      </Link>
      {/* A sibling of the link, never inside it: one shared menu opens on it (U4 §6.5). 32px on coarse pointers, so
          its expander reaches 4px, no further than its margin: it never covers the link (U4 §11.3). */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Actions for ${a.displayName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-row-more={a.slug}
        className="mx-1 shrink-0 text-muted-foreground pointer-coarse:size-8"
        onClick={(e) => onMenu(a.slug, e.currentTarget)}
      >
        <MoreHorizontal aria-hidden="true" />
      </Button>
    </li>
  );
});

const NO_CONTINUES: boolean[] = [];

/** The org tree: depth-first in server order, one link per agent. Only the name cell indents, so
 *  the other columns stay aligned. `flat` (the Ended view) keeps server order with no nesting. Each
 *  row has a ⋯ that opens the tree's one `AgentMenu`. */
export function AgentTree({
  agents,
  flat = false,
  usage,
  focus,
}: {
  agents: AgentSummary[];
  flat?: boolean;
  /** 7-day usage by slug; the cost cell stays empty until it arrives. */
  usage?: Map<string, AgentUsageRow>;
  /** A slug to scroll to and mark with the hover fill (Agent details' "All N reports", U2 §8.3). */
  focus?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const focusPresent = focus !== undefined && agents.some((a) => a.slug === focus);
  useEffect(() => {
    if (!focus || !focusPresent) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-agent-link="${CSS.escape(focus)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focus, focusPresent]);
  const isMobile = useIsMobile();
  // One clock per list: the ended notes' days are relative to it.
  const now = useMemo(() => new Date(), []);
  const bySlug = useMemo(() => new Map(agents.map((a) => [a.slug, a])), [agents]);
  // The shape (who is under whom) changes rarely; status frames don't touch it, so the depths and
  // tree lines stay the same arrays and the memoized rows skip.
  const shape = agents.map((a) => `${a.slug}>${flat ? "" : managerSlug(a)}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the key; `agents` is read for it
  const { levels, continues } = useMemo(() => {
    // Depth as drawn: a row whose manager isn't in this list starts a new root rather than hanging
    // under nothing. Server order is depth-first, so managers come first.
    const shown = new Map<string, number>();
    for (const a of agents) {
      const m = !flat && a.reportsTo.kind === "agent" ? shown.get(a.reportsTo.handle) : undefined;
      shown.set(a.slug, m === undefined ? 0 : m + 1);
    }
    const levels = agents.map((a) => shown.get(a.slug) ?? 0);
    return { levels, continues: continuations(levels) };
  }, [shape]);
  const cap = isMobile ? MOBILE_DEPTH_CAP : DESKTOP_DEPTH_CAP;

  // One AgentMenu for the list, opened on the row named here. The slug outlives the close so the
  // menu keeps its content for the exit animation.
  const [menu, setMenu] = useState<{
    slug: string | null;
    open: boolean;
    anchor: HTMLElement | null;
    at?: Point;
  }>({ slug: null, open: false, anchor: null });
  const menuSlug = menu.open ? menu.slug : null;
  const openMenu = useCallback(
    (slug: string, anchor?: HTMLElement, at?: Point) =>
      setMenu({
        slug,
        open: true,
        at,
        anchor:
          anchor ??
          listRef.current?.querySelector<HTMLElement>(`[data-row-more="${CSS.escape(slug)}"]`) ??
          null,
      }),
    [],
  );
  const onMenuOpenChange = useCallback((open: boolean) => setMenu((m) => ({ ...m, open })), []);
  const onMenuClose = useCallback((slug: string) => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-more="${CSS.escape(slug)}"]`)?.focus();
  }, []);
  const menuAgent = menu.slug ? bySlug.get(menu.slug) : undefined;
  return (
    <>
      <ul
        ref={listRef}
        aria-label="Agents"
        className="@container divide-y divide-border border-y border-border"
      >
        {agents.map((a, i) => {
          const manager = a.reportsTo.kind === "agent" ? bySlug.get(a.reportsTo.handle) : undefined;
          return (
            <AgentTreeRow
              key={a.slug}
              agent={a}
              level={levels[i] ?? 0}
              cap={cap}
              continues={continues[i] ?? NO_CONTINUES}
              managerName={manager?.displayName}
              usageRow={usage?.get(a.slug)}
              usageLoaded={usage !== undefined}
              flat={flat}
              focused={a.slug === focus}
              now={now}
              menuOpen={a.slug === menuSlug}
              onMenu={openMenu}
            />
          );
        })}
      </ul>
      {menuAgent ? (
        <AgentMenu
          agent={menuAgent}
          context="list"
          anchored={{
            open: menu.open,
            onOpenChange: onMenuOpenChange,
            anchor: menu.anchor,
            point: menu.at,
            onClose: () => onMenuClose(menuAgent.slug),
          }}
        />
      ) : null}
    </>
  );
}
