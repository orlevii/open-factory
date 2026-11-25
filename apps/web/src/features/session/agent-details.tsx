import { type AgentSummary, type AgentsUsage, summarizeChanges } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCw, X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { AgentChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { closeInstantly, Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CONFIG_PAGE_COPY } from "@/features/config/messages";
import { schedulesListOptions } from "@/features/schedules/api";
import { ScheduleTime } from "@/features/schedules/schedule-time";
import { preloadSheet, sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { agentTasksOptions } from "@/features/tasks/api";
import { STATUS } from "@/features/tasks/status-label";
import { agentsUsageQuery } from "@/features/usage/api";
import { formatCost } from "@/features/usage/format";
import { MOBILE, useMedia, WIDE, XWIDE } from "@/lib/breakpoints";
import { usePref } from "@/lib/prefs";
import { useShortcut } from "@/lib/shortcuts";
import { agentsListQueryOptions } from "./api";
import { CronsSegment } from "./crons-popover";
import { atPhrase, formatTime } from "./format";
import { formatBy } from "./format-by";
import { canPin, PinButton } from "./live-line";
import { LINK_CLASS } from "./message-block";
import { RestartNowButton } from "./restart-now-button";
import { registerAgentDetailsOpener } from "./session-commands";
import { Actor } from "./spawn-block";
import { resetPhrase } from "./status-badge";
import type { StopCrons } from "./stop-crons";
import type { TimelineHandle } from "./timeline";

export const RESTART_WHY =
  "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Its crons from this session stop, and it's told which, so it can recreate them.";

const MAX_REPORTS = 8;
const MAX_WORK = 5;
/** Past this many characters a description is likely to need the 3-line clamp; jsdom has no layout, so this is a length guess. */
const CLAMP_CHARS = 140;

export const WHATS_KEPT =
  "The session history stays here for good. The workspace (its files and Claude config) is deleted 3 days after it was terminated, unless you pin it. Worktrees and branches it made in projects are never deleted.";

/** "Terminated by @lead today at 14:32." or, for the inactivity TTL, "Terminated on … after 3 days
 *  without activity." */
export function endedSentence(agent: AgentSummary, now: Date): ReactNode {
  const when = atPhrase(new Date(agent.terminatedAt ?? 0), now);
  const by = agent.terminatedBy;
  if (!by) return `Terminated ${when}.`;
  if (formatBy(by).kind === "ttl") return `Terminated ${when} after 3 days without activity.`;
  return (
    <>
      Terminated by <Actor by={by} /> {when}.
    </>
  );
}

/** What became of the workspace; `undefined` when there is nothing to say. */
export function workspaceSentence(agent: AgentSummary, now: Date): string | undefined {
  if (agent.workspaceDeletedAt)
    return `Workspace deleted ${atPhrase(new Date(agent.workspaceDeletedAt), now)}.`;
  if (agent.workspacePinned) return "Workspace pinned.";
  const grace = agent.workspaceGraceEndsAt;
  if (!grace) return undefined;
  const ends = new Date(grace);
  // The sweep runs every 10 minutes and retries a failing deletion: past the grace it is "due".
  if (ends.getTime() <= now.getTime())
    return `Workspace due for deletion since ${atPhrase(ends, now).replace(/^on /, "")} unless you pin it.`;
  return `Workspace will be deleted ${atPhrase(ends, now)} unless you pin it.`;
}

export function WhatsKept() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          What's kept?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
        <p>{WHATS_KEPT}</p>
      </PopoverContent>
    </Popover>
  );
}

const waitingText = (n: number) =>
  n > 0 ? ` (waiting on ${n} background ${n === 1 ? "task" : "tasks"})` : "";

/** A "Why?" ghost button with its explanation in a popover; `label` is its distinct accessible name. */
export function Why({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" aria-label={label}>
          Why?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-[0.8125rem] leading-[1.125rem]">
        <p>{children}</p>
      </PopoverContent>
    </Popover>
  );
}

/** Why a local agent can't start here (S5 UI design §3.2): Agent details' Runtime row and a
 *  timeline error with `fix: "runtime"` both offer it. */
export function LocalRuntimeWhy() {
  return (
    <Why label="Why is the local runtime disabled?">
      An operator has to allow unsandboxed agents by setting{" "}
      <code className="font-mono">FACTORY_ALLOW_LOCAL_RUNTIME=true</code>. Until then this agent
      can't start.
    </Why>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-b border-border px-4 py-3 text-[0.8125rem] leading-[1.125rem]">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clampable = text.length > CLAMP_CHARS;
  return (
    <div className="grid justify-items-start gap-1">
      <p className={`text-muted-foreground whitespace-pre-line ${open ? "" : "line-clamp-3"}`}>
        {text}
      </p>
      {clampable && (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-ml-2"
        >
          {open ? "Less" : "More"}
        </Button>
      )}
    </div>
  );
}

/** Why messages aren't going out right now (the header's wording, in full). */
function detailText(agent: AgentSummary): ReactNode {
  if (agent.pulling) return "Pulling the image…";
  if (agent.status === "rate_limited")
    return (
      <>
        Paused: credential <span className="font-mono">{agent.credential}</span> is rate-limited
        {resetPhrase(agent)?.joined ?? ""}. Messages wait until then.
      </>
    );
  return null;
}

function Now({
  agent,
  stop,
  onAgent,
}: {
  agent: AgentSummary;
  stop: StopCrons;
  onAgent?: (a: AgentSummary) => void;
}) {
  const terminated = agent.status === "terminated" || !!agent.terminatedAt;
  const rows: { key: string; node: ReactNode }[] = [];
  if (terminated) {
    const now = new Date();
    const workspace = workspaceSentence(agent, now);
    const stuck = agent.stuck
      ? " Its container couldn't be removed; the factory keeps retrying."
      : "";
    rows.push({
      key: "terminated",
      node: (
        // The sentence fills its line and each action starts its own (Pin's outcome line sits
        // between them), so the ghost buttons are pulled back by their padding to line up with it.
        <div className="flex flex-wrap items-center gap-x-2 [&>button]:-ml-2">
          <span data-terminated-text className="basis-full">
            {endedSentence(agent, now)}
            {`${workspace ? ` ${workspace}` : ""}${stuck}`}
          </span>
          {canPin(agent) && <PinButton agent={agent} onAgent={onAgent} />}
          <WhatsKept />
        </div>
      ),
    });
  } else {
    if (agent.status === "errored" && agent.lastError)
      rows.push({
        key: "error",
        node: <span className="whitespace-pre-line text-destructive">{agent.lastError}</span>,
      });
    const detail = detailText(agent);
    if (detail) rows.push({ key: "detail", node: <span>{detail}</span> });
    if (agent.restartPending) {
      const changes = agent.restartChanges;
      rows.push({
        key: "restart",
        node: (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
            {changes.length > 0
              ? `Restarts when idle to apply: ${summarizeChanges(changes)}`
              : "Restarts when idle to apply changes"}
            {waitingText(agent.restartWaitingOn)}
            <Why label="Why does it restart?">{RESTART_WHY}</Why>
            <RestartNowButton slug={agent.slug} />
            {changes.length > 0 && (
              <span className="block basis-full pl-5 [overflow-wrap:anywhere]">
                {changes.map((c) => (
                  <span key={c} className="block">
                    {c}
                  </span>
                ))}
              </span>
            )}
          </span>
        ),
      });
    }
    for (const t of agent.waitingOn.tasks)
      rows.push({
        key: t.taskId,
        node: (
          <span>
            {t.description || t.taskId} (background) · since {formatTime(t.startedAt)}
          </span>
        ),
      });
    if (agent.waitingOn.crons > 0)
      rows.push({
        key: "crons",
        node: (
          <span>
            Kept awake by <CronsSegment agent={agent} stop={stop} />
          </span>
        ),
      });
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Now">
      {rows.map((r) => (
        <div key={r.key}>{r.node}</div>
      ))}
    </Section>
  );
}

function Org({ agent }: { agent: AgentSummary }) {
  const slug = agent.slug;
  const select = useCallback((l: AgentSummary[]) => l.filter((a) => a.reportsTo === slug), [slug]);
  // A cache read for the reports shown; the list is the sidebar's, never fetched from here.
  const reports = useQuery({
    ...agentsListQueryOptions("exclude"),
    refetchOnMount: false,
    select,
  }).data;
  const shown = reports?.slice(0, MAX_REPORTS) ?? [];
  return (
    <Section title="Org">
      <div className="flex flex-wrap items-center gap-x-2 @container">
        <span className="text-muted-foreground">
          {agent.kind === "ephemeral" ? "Spawned by" : "Reports to"}
        </span>
        {agent.reportsTo ? (
          <AgentChip slug={agent.reportsTo} link size={16} />
        ) : (
          <span>No manager</span>
        )}
      </div>
      {agent.reports > 0 && (
        <ul className="grid gap-1.5 @container">
          {shown.map((r) => (
            <li key={r.slug} className="flex min-w-0">
              <AgentChip agent={r} link size={16} badge />
            </li>
          ))}
        </ul>
      )}
      {agent.reports > MAX_REPORTS && (
        <Link to="/agents" search={{ focus: slug }} className={`justify-self-start ${LINK_CLASS}`}>
          All {agent.reports} reports
        </Link>
      )}
    </Section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Phones: Agent details is a modal drawer. A sheet opened from it would be a second, unstacked Vaul root, and Vaul's
 *  one saved body position would be restored under it (spec §5.3). So the drawer closes at once first, and the sheet
 *  opens over the session alone. */
function openFromDetails(onClose: (() => void) | undefined, open: () => void) {
  const el = document.getElementById(AGENT_DETAILS_ID);
  if (onClose && el?.matches("[data-slot=drawer-content]")) {
    closeInstantly(el);
    flushSync(onClose);
  }
  open();
}

function Work({ agent, onClose }: { agent: AgentSummary; onClose?: (() => void) | undefined }) {
  // Mounted only while Agent details is open, so these fetch only then; no count, nothing to ask.
  const tasks = useQuery({ ...agentTasksOptions(agent.slug), enabled: agent.openTasks > 0 }).data;
  const schedules = useQuery({
    ...schedulesListOptions({ target: agent.slug }),
    enabled: agent.scheduleCount > 0,
  }).data?.schedules;
  if (agent.openTasks === 0 && agent.scheduleCount === 0) return null;
  const now = new Date();
  return (
    <Section title="Work">
      {agent.openTasks > 0 && (
        <div className="grid gap-1">
          <ul className="grid gap-1">
            {tasks?.slice(0, MAX_WORK).map((t) => {
              const S = STATUS[t.status];
              return (
                <li key={t.key} className="flex min-w-0 items-baseline gap-1.5">
                  <S.Icon aria-hidden="true" className={`size-3 shrink-0 self-center ${S.icon}`} />
                  <Link
                    to="/tasks/$key"
                    params={{ key: t.key }}
                    className={`flex min-w-0 items-baseline gap-1.5 ${LINK_CLASS}`}
                  >
                    <span className="shrink-0 font-mono text-foreground">{t.key}</span>
                    <span className="min-w-0 truncate text-foreground">{t.title}</span>
                  </Link>
                  <span className="sr-only">{S.label}</span>
                </li>
              );
            })}
          </ul>
          <Link
            to="/tasks"
            search={{ assignee: agent.slug }}
            className={`justify-self-start ${LINK_CLASS}`}
          >
            All {plural(agent.openTasks, "task", "tasks")}
          </Link>
        </div>
      )}
      {agent.scheduleCount > 0 && (
        <div className="grid gap-1">
          <ul className="grid gap-1">
            {schedules?.slice(0, MAX_WORK).map((s) => (
              <li key={s.key} className="flex min-w-0 items-baseline justify-between gap-2">
                <button
                  type="button"
                  className={`font-mono text-foreground ${LINK_CLASS}`}
                  onPointerEnter={() =>
                    preloadSheet("edit-schedule", { kind: "edit-schedule", key: s.key })
                  }
                  onFocus={() =>
                    preloadSheet("edit-schedule", { kind: "edit-schedule", key: s.key })
                  }
                  onClick={() =>
                    openFromDetails(onClose, () => openSheet({ kind: "edit-schedule", key: s.key }))
                  }
                >
                  {s.key}
                </button>
                <span className="truncate text-muted-foreground">
                  {s.nextRunAt ? (
                    <>
                      Next:{" "}
                      <ScheduleTime at={s.nextRunAt} zone={s.timezone} now={now} showZone={false} />
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to="/schedules"
            search={{ target: agent.slug }}
            className={`justify-self-start ${LINK_CLASS}`}
          >
            All {plural(agent.scheduleCount, "schedule", "schedules")}
          </Link>
        </div>
      )}
    </Section>
  );
}

function Usage({ agent }: { agent: AgentSummary }) {
  // The 7-day row for this agent: null once loaded without one, undefined while loading. Mounted
  // only while Agent details is open, so the all-agents fetch runs only then.
  const slug = agent.slug;
  const select = useCallback(
    (d: AgentsUsage) => d.agents.find((r) => r.slug === slug) ?? null,
    [slug],
  );
  const usage = useQuery({ ...agentsUsageQuery("rolling7"), select }).data;
  const t = usage && (usage.kind === "ephemeral" ? usage.own : usage.total);
  const cost = t && t.turns > 0 ? formatCost(t.costUsd, t.turns) : null;
  return (
    <Section title="Usage">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground tabular-nums">
          {cost ? `${cost} est. · 7d` : usage === undefined ? "" : "No turns in the last 7 days"}
        </span>
        <Link
          to="/agents/$slug/usage"
          params={{ slug: agent.slug }}
          search={{}}
          className={LINK_CLASS}
        >
          Usage
        </Link>
      </div>
    </Section>
  );
}

function Runtime({ agent }: { agent: AgentSummary }) {
  return (
    <Section title="Runtime">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Template</dt>
        <dd className="min-w-0 truncate">
          <Link
            to="/templates/$name"
            params={{ name: agent.template }}
            className={`font-mono ${LINK_CLASS}`}
          >
            {agent.template}
          </Link>
        </dd>
        {/* A terminated agent has nothing to configure (AgentMenu hides Configure for it too). */}
        {agent.status !== "terminated" && !agent.terminatedAt && (
          <>
            <dt className="text-muted-foreground">Configuration</dt>
            <dd className="min-w-0">
              <Link to="/agents/$slug/config" params={{ slug: agent.slug }} className={LINK_CLASS}>
                {CONFIG_PAGE_COPY.openConfiguration}
              </Link>
            </dd>
          </>
        )}
        {agent.credential !== null && (
          <>
            <dt className="text-muted-foreground">Credential</dt>
            <dd className="min-w-0 truncate font-mono">{agent.credential}</dd>
          </>
        )}
        {agent.runtime === "docker" && agent.image && (
          <>
            <dt className="text-muted-foreground">Image</dt>
            <dd className="min-w-0">
              <span className="font-mono [overflow-wrap:anywhere]">
                {agent.image.running ?? agent.image.next}
              </span>
              {agent.pulling && " (pulling)"}
            </dd>
          </>
        )}
        {agent.manageOrg && (
          <>
            <dt className="text-muted-foreground">Manages the org</dt>
            <dd className="min-w-0">Yes</dd>
          </>
        )}
        {agent.projects.length > 0 && (
          <>
            <dt className="text-muted-foreground">Projects</dt>
            <dd className="flex min-w-0 flex-wrap gap-x-2 font-mono">
              {agent.projects.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {agent.runtime === "local" && (
        <p className="flex flex-wrap items-center gap-x-1.5">
          <span>
            Unsandboxed
            {agent.runtimeDisabled && (
              <span className="text-muted-foreground"> · disabled on this factory</span>
            )}
          </span>
          {agent.runtimeDisabled && <LocalRuntimeWhy />}
        </p>
      )}
    </Section>
  );
}

/**
 * The agent's facts, the same in the in-flow column, the sheet and the drawer (U2 §8.3). Mounted
 * only while open, so its task and schedule queries fire only then.
 */
export function AgentDetails({
  agent,
  stop,
  onClose,
  onAgent,
}: {
  agent: AgentSummary;
  stop: StopCrons;
  /** Shown in the sheet and drawer modes. */
  onClose?: (() => void) | undefined;
  /** A fresh summary from a pin/unpin response. */
  onAgent?: ((a: AgentSummary) => void) | undefined;
}) {
  const canEdit = agent.kind === "persistent" && agent.archivedAt === null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-medium">Agent details</h2>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close agent details" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-1 border-b border-border px-4 py-3 text-[0.8125rem] leading-[1.125rem]">
          <p className="font-mono [overflow-wrap:anywhere]">@{agent.slug}</p>
          {agent.description && <Description text={agent.description} />}
        </div>
        <Now agent={agent} stop={stop} onAgent={onAgent} />
        <Org agent={agent} />
        <Work agent={agent} onClose={onClose} />
        <Usage agent={agent} />
        <Runtime agent={agent} />
      </div>
      {canEdit && (
        <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            {...sheetIntent("edit-agent", { kind: "edit-agent", slug: agent.slug })}
            onClick={() => openSheet({ kind: "edit-agent", slug: agent.slug })}
          >
            Edit agent
          </Button>
        </div>
      )}
    </div>
  );
}

export type AgentDetailsMode = "inflow" | "overlay" | "drawer";
export type AgentDetailsPanel = {
  open: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  mode: AgentDetailsMode;
  /** The session's timeline: every open or close takes its scroll anchor first (spec §8.1, Q24),
   *  whatever asked for it (`]`, the header toggle, the ⋯ menu, the panel's own close). */
  timeline: RefObject<TimelineHandle | null>;
};

/** "closed" once the human closed Agent details at ≥1280px; it then stays closed there. */
export const AGENT_DETAILS_PREF = "of-agent-details";
/** The in-flow column's and the sheet's id, for the header toggle's `aria-controls`. */
export const AGENT_DETAILS_ID = "agent-details";
export const AGENT_DETAILS_TOGGLE_ID = "agent-details-toggle";
const parseOpenPref = (raw: string) => (raw === "open" || raw === "closed" ? raw : undefined);
/** The open modal is Agent details' own drawer. */
const ownsDetails = (modal: Element) => modal.id === AGENT_DETAILS_ID;

/**
 * Where Agent details shows and whether it is open (U2 §8.1). ≥1280: in-flow, open unless the human
 * closed it there (remembered); 1024–1279: in-flow, closed on each visit; 768–1023: a peek sheet
 * under the header; below, the bottom drawer. Called once per session page, above the per-agent
 * view, so an open panel stays open when the human switches agents; a closed one starts each agent
 * at its width's default. A sheet opened below 1024px stays a sheet until it closes (the U1 latch).
 * `]` toggles it while the page is mounted.
 */
export function useAgentDetailsPanel(slug: string): AgentDetailsPanel {
  const xwide = useMedia(XWIDE);
  const wide = useMedia(WIDE);
  const mobile = useMedia(MOBILE);
  const [pref, setPref] = usePref<"open" | "closed">(AGENT_DETAILS_PREF, "open", parseOpenPref);
  const [state, setState] = useState<{ slug: string; open: boolean; sheet: boolean } | null>(null);
  const byWidth: AgentDetailsMode = wide ? "inflow" : mobile ? "drawer" : "overlay";
  const fallback = xwide && pref === "open";
  // Derived, never reset by an effect: the state applies to its own slug, or follows to the next one
  // while open.
  const carried = state !== null && (state.slug === slug || state.open);
  const open = carried ? state.open : fallback;
  const latched = open && carried && state.sheet && byWidth === "inflow";
  const mode: AgentDetailsMode = latched ? "overlay" : byWidth;

  const latest = useRef({ slug, open, xwide, fallback, mode });
  latest.current = { slug, open, xwide, fallback, mode };
  const timeline = useRef<TimelineHandle>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      const c = latest.current;
      // Before the column resizes the timeline, so the top row keeps its place.
      timeline.current?.captureAnchor();
      setState({ slug: c.slug, open: next, sheet: c.mode !== "inflow" });
      // Remembered only for the column where it is open by default (not a latched sheet).
      if (c.xwide && c.mode === "inflow") setPref(next ? "open" : "closed");
    },
    [setPref],
  );
  const toggle = useCallback(() => setOpen(!latest.current.open), [setOpen]);
  useEffect(() => registerAgentDetailsOpener(() => setOpen(true)), [setOpen]);
  useShortcut(
    "]",
    () => {
      const c = latest.current;
      // A key that closes an overlay closes it at once, however it opened (§16.8).
      if (c.open && c.mode !== "inflow")
        closeInstantly(document.getElementById(AGENT_DETAILS_ID), () => setOpen(false));
      else toggle();
    },
    // The phone drawer is modal, and `]` still closes it (§8.1: at every width).
    { allowInModal: ownsDetails },
  );
  return useMemo(() => ({ open, toggle, setOpen, mode, timeline }), [open, toggle, setOpen, mode]);
}

/**
 * The 768–1023 peek sheet and the phone drawer. It lives above the per-agent view (which remounts
 * for each agent), so switching agents swaps its content in place: the view portals `AgentDetails`
 * into the node handed to `onHost`.
 */
export function AgentDetailsSheet({
  panel,
  onHost,
}: {
  panel: AgentDetailsPanel;
  onHost: (node: HTMLDivElement | null) => void;
}) {
  return (
    <Sheet open={panel.open && panel.mode !== "inflow"} onOpenChange={panel.setOpen} modal={false}>
      <SheetContent
        id={AGENT_DETAILS_ID}
        width="panel"
        inset="below-header"
        keepFocus={false}
        aria-describedby={undefined}
        className="bg-card"
        returnFocus={() => document.getElementById(AGENT_DETAILS_TOGGLE_ID)}
        // A non-modal peek: closed while focus is elsewhere on the page (Esc in the composer), focus
        // stays there rather than jumping to the toggle. Only focus that was inside goes back to it.
        onCloseAutoFocus={(e) => {
          const at = document.activeElement;
          const inside = document.getElementById(AGENT_DETAILS_ID)?.contains(at);
          if (at && at !== document.body && !inside) e.preventDefault();
        }}
      >
        {/* The dialog's name; the visible strip inside repeats it as a heading. */}
        <SheetTitle className="sr-only">Agent details</SheetTitle>
        <div ref={onHost} className="flex min-h-0 flex-1 flex-col" />
      </SheetContent>
    </Sheet>
  );
}
