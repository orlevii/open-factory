import { type AgentSummary, treeOrder } from "@open-factory/shared";
import {
  keepPreviousData,
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AgentChip } from "@/components/agent-chip";
import { isMac } from "@/components/ui/kbd";
import { agentsListQueryOptions, endedMoreQueryKey } from "@/features/session/api";
import { openAgentDetails, requestComposerFocus } from "@/features/session/session-commands";
import { openShortcutsSheet } from "@/features/shortcuts/sheet-store";
import { newTask } from "@/features/tasks/actions";
import { lookupTasks, tasksSearchOptions } from "@/features/tasks/api";
import { StatusLabel } from "@/features/tasks/status-label";
import { setPreference } from "@/lib/theme";
import { ACTIONS, type ActionItem, GO_TO, isTaskKey, type RankedAgent, rankAgents } from "./rank";
import { readRecentAgents } from "./recent";

// --- Open state: a module-level store, so the sidebar's Search row and ⌘K open the one palette. ---
let isOpen = false;
/** Focused when it opened: a plain close (Esc, a click outside) returns focus there. Radix's modal
 *  Dialog only returns focus to its own Trigger, and the palette has none. */
let opener: HTMLElement | null = null;
/** Replaces the opener as the return target when the opener won't be there (the phone's nav drawer
 *  closes as the palette opens). */
let returnTarget: (() => HTMLElement | null) | null = null;
const listeners = new Set<() => void>();
function setPaletteOpen(next: boolean, returnFocus?: () => HTMLElement | null) {
  if (next === isOpen) return;
  isOpen = next;
  if (next) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnTarget = returnFocus ?? null;
  }
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getOpen = () => isOpen;

/** `returnFocus` names where a plain close returns focus, instead of the element focused at opening. */
export function openPalette(returnFocus?: () => HTMLElement | null) {
  setPaletteOpen(true, returnFocus);
}

/** Warms the ended agents list (hover or focus on the Search row, the ⌘K keydown). Respects the
 *  cache's staleTime, so repeated hovers fetch nothing. */
export function prefetchPaletteData(qc: QueryClient) {
  void qc.prefetchQuery(agentsListQueryOptions("only"));
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere (Ctrl+K is a text-field chord on macOS). */
function isPaletteKey(e: KeyboardEvent) {
  const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

const NOTHING = () => {};
const SEARCH_DEBOUNCE_MS = 150;
const MIN_SEARCH = 2;
const SESSION_PATH = /^\/agents\/(?!new\/?$)[^/]+\/?$/;

const isLive = (a: AgentSummary) => !a.archivedAt && !a.terminatedAt;

/** The sidebar tree's order (depth-first under each manager) for each live list, computed once. */
const treeOrders = new WeakMap<AgentSummary[], string[]>();
function treeOrderOf(live: AgentSummary[]): string[] {
  let order = treeOrders.get(live);
  if (!order) {
    order = treeOrder(live).map((r) => r.slug);
    treeOrders.set(live, order);
  }
  return order;
}

/** At most this many agent rows render; exact, prefix and recent matches are never cut. */
const AGENT_ROWS = 50;
type AgentRows = { rows: RankedAgent[]; cut: boolean };

/** Reads the cached lists once (no subscription: a status frame never re-renders or reorders the
 *  palette) and ranks them for `query`. */
function rankFromCache(qc: QueryClient, query: string): AgentRows {
  const cached = qc.getQueryData<AgentSummary[]>(agentsListQueryOptions("exclude").queryKey) ?? [];
  const live = cached.filter(isLive);
  const ended = qc.getQueryData<AgentSummary[]>(agentsListQueryOptions("only").queryKey) ?? [];
  const ranked = rankAgents(query, live, ended, readRecentAgents(), treeOrderOf(cached));
  if (ranked.length <= AGENT_ROWS) return { rows: ranked, cut: false };
  let room = AGENT_ROWS - ranked.filter((r) => r.strong).length;
  const rows = ranked.filter((r) => r.strong || room-- > 0);
  return { rows, cut: true };
}

const matches = (label: string, q: string) => q === "" || label.toLowerCase().includes(q);

const groupClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground";
const itemClass =
  "flex min-h-8 pointer-coarse:min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none data-[selected=true]:bg-accent data-[disabled=true]:text-muted-foreground";

/**
 * ⌘K: jump to any agent, task or page (spec §10.2). A modal Radix Dialog around a cmdk list that
 * never animates; mounted once in the app shell and loaded eagerly.
 */
export function CommandPalette() {
  const open = useSyncExternalStore(subscribe, getOpen, getOpen);
  const qc = useQueryClient();
  // Work to run once the dialog has closed and its focus return is skipped (⇧Enter's composer).
  const afterClose = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Capture phase on window, before the shortcut layer's editable-target rules: ⌘K works in a field.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || !isPaletteKey(e)) return;
      e.preventDefault();
      if (!isOpen) prefetchPaletteData(qc);
      setPaletteOpen(!isOpen);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // Leaving the app shell (sign-out) closes it, so the next shell doesn't open with it.
      setPaletteOpen(false);
    };
  }, [qc]);

  return (
    <Dialog.Root open={open} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        {/* Never animates, however it opened (DESIGN.md → Motion): no enter/exit classes at all. */}
        <Dialog.Overlay
          data-instant=""
          data-slot="palette-overlay"
          className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40"
        />
        <Dialog.Content
          data-instant=""
          data-slot="palette"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            const run = afterClose.current;
            const back = returnTarget ? returnTarget() : opener;
            afterClose.current = null;
            opener = null;
            returnTarget = null;
            e.preventDefault();
            if (run) run();
            else if (back?.isConnected) back.focus();
          }}
          className="fixed top-[15vh] left-1/2 z-50 flex w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-float-edge bg-popover text-popover-foreground outline-hidden max-md:top-2" // ui-contract:allow the surface takes focus only programmatically; the field inside opens focused
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <PaletteBody afterClose={afterClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Mounted per opening (the Content unmounts on close), so each opening starts from an empty query. */
function PaletteBody({ afterClose }: { afterClose: RefObject<(() => void) | null> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const onSession = useRouterState({ select: (s) => SESSION_PATH.test(s.location.pathname) });
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [{ rows: agents, cut }, setAgents] = useState(() => rankFromCache(qc, ""));
  const latestQuery = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ⇧ on the committing Enter or click: open the session and focus its composer.
  const shift = useRef(false);

  useEffect(() => () => clearTimeout(timer.current), []);
  // The ended list is usually warm (prefetched on ⌘K or the Search row); if it wasn't, rank again
  // once when it lands.
  useEffect(() => {
    const opts = agentsListQueryOptions("only");
    if (qc.getQueryData(opts.queryKey)) return;
    let live = true;
    qc.ensureQueryData(opts).then(
      () => live && setAgents(rankFromCache(qc, latestQuery.current)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [qc]);

  const onQuery = (value: string) => {
    setQuery(value);
    latestQuery.current = value;
    setAgents(rankFromCache(qc, value));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(value.trim()), SEARCH_DEBOUNCE_MS);
  };

  const q = query.trim();
  const lower = q.toLowerCase();
  const taskKey = isTaskKey(q) ? q.toUpperCase() : null;
  const debouncedKey = isTaskKey(debounced) ? debounced.toUpperCase() : null;
  const keyLookup = useQuery({
    queryKey: ["tasks", "key", debouncedKey] as const,
    queryFn: () =>
      lookupTasks([debouncedKey as string]).then(
        (t) => t.find((x) => x.key === debouncedKey) ?? null,
      ),
    enabled: debouncedKey !== null,
  });
  const keyTitle = taskKey !== null && taskKey === debouncedKey ? keyLookup.data?.title : undefined;

  const tasks = useQuery({
    ...tasksSearchOptions(debounced),
    enabled: debounced.length >= MIN_SEARCH,
    placeholderData: keepPreviousData,
  });
  // Rows from an earlier query (still debouncing, or the new answer not in yet) are muted and inert.
  const staleTasks = tasks.isPlaceholderData || debounced !== q;
  const taskRows = q.length >= MIN_SEARCH ? (tasks.data ?? []) : [];

  const endedMore = agents.some((a) => a.ended) && qc.getQueryData<boolean>(endedMoreQueryKey);
  const goTo = GO_TO.filter((g) => matches(g.label, lower));
  const actions = ACTIONS.filter((a) => (!a.sessionOnly || onSession) && matches(a.label, lower));

  /** Closes the palette, then runs `go`. `after` runs once the dialog has let go of focus (in its
   *  close hand-off, so nothing it focuses is taken back); null returns focus to where ⌘K was
   *  pressed. */
  const commit = (go: () => void, after: (() => void) | null) => {
    afterClose.current = after;
    setPaletteOpen(false);
    go();
  };
  /** A new page: focus is not sent back to the page being left. */
  const leave = (go: () => void) => commit(go, NOTHING);
  const openAgent = (slug: string) => {
    commit(
      () => void navigate({ to: "/agents/$slug", params: { slug } }),
      shift.current ? () => requestComposerFocus(slug) : NOTHING,
    );
  };
  const runAction = (a: ActionItem) => {
    switch (a.kind) {
      case "navigate":
        return leave(() => void navigate({ to: a.to as string }));
      case "new-task":
        return leave(() => newTask(navigate));
      case "agent-details":
        // Opened after the close hand-off: a peek sheet doesn't trap focus, so the dialog's focus
        // return would otherwise pull focus back out of it.
        return commit(NOTHING, openAgentDetails);
      case "theme-system":
        return commit(() => setPreference("system"), null);
      case "theme-light":
        return commit(() => setPreference("light"), null);
      case "theme-dark":
        return commit(() => setPreference("dark"), null);
      case "shortcuts":
        return commit(NOTHING, openShortcutsSheet);
    }
  };

  return (
    <Command
      label="Search"
      shouldFilter={false}
      loop
      onKeyDown={(e) => {
        if (e.key === "Enter") shift.current = e.shiftKey;
      }}
      onClickCapture={(e) => {
        shift.current = e.shiftKey;
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-3">
        <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          value={query}
          onValueChange={onQuery}
          placeholder="Search agents, tasks and pages…"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground" // ui-contract:allow the palette's only field opens focused; its caret marks it
        />
      </div>
      <Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain scroll-py-1 p-1 max-md:max-h-[40dvh]">
        <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
          No results.
        </Command.Empty>
        {agents.length > 0 && (
          <Command.Group heading="Agents" className={groupClass}>
            {agents.map(({ agent, ended }) => (
              <Command.Item
                key={agent.slug}
                value={`agent:${agent.slug}`}
                onSelect={() => openAgent(agent.slug)}
                className={itemClass}
              >
                <AgentChip agent={agent} size={16} showSlug className="min-w-0 flex-1" />
                {ended && <span className="shrink-0 text-xs text-muted-foreground">Ended</span>}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {taskKey && (
          <Command.Group className={groupClass}>
            <Command.Item
              value={`key:${taskKey}`}
              onSelect={() =>
                leave(() => void navigate({ to: "/tasks/$key", params: { key: taskKey } }))
              }
              className={itemClass}
            >
              <span className="shrink-0">Open {taskKey}</span>
              {keyTitle && (
                <span className="min-w-0 truncate text-muted-foreground">{keyTitle}</span>
              )}
            </Command.Item>
          </Command.Group>
        )}
        {goTo.length > 0 && (
          <Command.Group heading="Go to" className={groupClass}>
            {goTo.map((g) => (
              <Command.Item
                key={g.id}
                value={`go:${g.id}`}
                onSelect={() =>
                  leave(() => void navigate({ to: g.to, ...(g.hash ? { hash: g.hash } : {}) }))
                }
                className={itemClass}
              >
                {g.label}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {actions.length > 0 && (
          <Command.Group heading="Actions" className={groupClass}>
            {actions.map((a) => (
              <Command.Item
                key={a.id}
                value={`action:${a.id}`}
                onSelect={() => runAction(a)}
                className={itemClass}
              >
                {a.label}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {taskRows.length > 0 && (
          // Fresh rows mount anew, so cmdk highlights the first one if nothing is highlighted.
          <Command.Group
            key={staleTasks ? "stale" : `q:${debounced}`}
            heading="Tasks"
            className={groupClass}
          >
            {taskRows.map((t) => (
              <Command.Item
                key={t.key}
                value={`task:${t.key}`}
                disabled={staleTasks}
                onSelect={() => {
                  if (staleTasks) return;
                  leave(() => void navigate({ to: "/tasks/$key", params: { key: t.key } }));
                }}
                className={itemClass}
              >
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <StatusLabel status={t.status} className="shrink-0 text-xs" />
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      {/* Notes about the agent rows, outside the list box (a list box holds only options). */}
      {(cut || endedMore) && (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {cut && <p>Keep typing to narrow the agents.</p>}
          {endedMore && <p>Showing the 200 most recently ended</p>}
        </div>
      )}
    </Command>
  );
}
