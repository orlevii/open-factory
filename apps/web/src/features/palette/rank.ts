import type { AgentSummary } from "@open-factory/shared";
import type { SheetSpec } from "@/features/sheets/sheet-store";

export interface RankedAgent {
  agent: AgentSummary;
  ended: boolean;
  /** An exact, prefix or recent match (or a recent agent for the empty query), never cut from a
   *  capped list; substring matches are. */
  strong: boolean;
}

const TASK_KEY = /^t-\d+$/i;
export function isTaskKey(q: string): boolean {
  return TASK_KEY.test(q);
}

// Match tiers, best first.
const EXACT_SLUG = 0;
const EXACT_NAME = 1;
const PREFIX = 2;
const RECENT = 3;
const SUBSTRING = 4;

interface Hit {
  agent: AgentSummary;
  ended: boolean;
  tier: number;
  order: number;
}

function indexOf(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const s = list[i] as string;
    if (!m.has(s)) m.set(s, i);
  }
  return m;
}

/**
 * Ranks agents for the palette. Pure and snapshot-friendly: call it when the query changes, not on
 * every status frame. Live agents come before ended ones; within each, exact slug, exact name,
 * prefix, recent, then substring; ties keep tree order (agents missing from `treeOrder` go last,
 * in input order). An empty query lists only the recent agents, in recency order.
 */
export function rankAgents(
  query: string,
  live: AgentSummary[],
  ended: AgentSummary[],
  recent: string[],
  treeOrder: string[],
): RankedAgent[] {
  let q = query.trim().toLowerCase();
  if (q.startsWith("@")) q = q.slice(1);

  if (q === "") {
    if (recent.length === 0) return [];
    const bySlug = new Map<string, RankedAgent>();
    for (const agent of ended) bySlug.set(agent.slug, { agent, ended: true, strong: true });
    for (const agent of live) bySlug.set(agent.slug, { agent, ended: false, strong: true });
    const out: RankedAgent[] = [];
    const seen = new Set<string>();
    for (const slug of recent) {
      const hit = bySlug.get(slug);
      if (hit && !seen.has(slug)) {
        seen.add(slug);
        out.push(hit);
      }
    }
    return out;
  }

  const tree = indexOf(treeOrder);
  const recents = new Set(recent);
  const seen = new Set<string>();
  const hits: Hit[] = [];
  let n = 0;

  const collect = (list: AgentSummary[], isEnded: boolean) => {
    for (const agent of list) {
      if (seen.has(agent.slug)) continue;
      const slug = agent.slug.toLowerCase();
      const name = agent.displayName.toLowerCase();
      let tier: number;
      if (slug === q) tier = EXACT_SLUG;
      else if (name === q) tier = EXACT_NAME;
      else if (slug.startsWith(q) || name.startsWith(q)) tier = PREFIX;
      else if (slug.includes(q) || name.includes(q))
        tier = recents.has(agent.slug) ? RECENT : SUBSTRING;
      else continue;
      seen.add(agent.slug);
      hits.push({
        agent,
        ended: isEnded,
        tier,
        order: tree.get(agent.slug) ?? treeOrder.length + n,
      });
      n++;
    }
  };
  collect(live, false);
  collect(ended, true);

  hits.sort((x, y) => Number(x.ended) - Number(y.ended) || x.tier - y.tier || x.order - y.order);
  return hits.map(({ agent, ended, tier }) => ({ agent, ended, strong: tier < SUBSTRING }));
}

export interface GoToItem {
  id: string;
  label: string;
  to: string;
}

/** §10.2 "Go to". */
export const GO_TO: readonly GoToItem[] = [
  { id: "inbox", label: "Inbox", to: "/inbox" },
  { id: "agents", label: "Agents", to: "/agents" },
  { id: "tasks", label: "Tasks", to: "/tasks" },
  { id: "templates", label: "Templates", to: "/templates" },
  { id: "images", label: "Images", to: "/templates/images" },
  { id: "skills", label: "Skills", to: "/skills" },
  { id: "schedules", label: "Schedules", to: "/schedules" },
  { id: "usage", label: "Usage", to: "/usage" },
  { id: "settings-credentials", label: "Settings: Credentials", to: "/settings/credentials" },
  { id: "settings-secrets", label: "Settings: Secrets", to: "/settings/secrets" },
  { id: "settings-projects", label: "Settings: Projects", to: "/settings/projects" },
  { id: "settings-users", label: "Settings: Users", to: "/settings/users" },
  { id: "settings-factory", label: "Settings: Factory", to: "/settings/factory" },
];

export type ActionKind =
  | "navigate"
  | "open-sheet"
  | "agent-details"
  | "switch-view"
  | "theme-system"
  | "theme-light"
  | "theme-dark"
  | "shortcuts";

export interface ActionItem {
  id: string;
  label: string;
  kind: ActionKind;
  /** Navigation target for `navigate`. */
  to?: string;
  /** The sheet an `open-sheet` action opens. */
  sheet?: SheetSpec["kind"];
  /** Only offered on this agent page: `agent` is either view, `chat` and `session` that one. */
  on?: "agent" | "chat" | "session";
}

/** §10.2 "Actions". There is deliberately no "Mark all read" (Q28). */
export const ACTIONS: readonly ActionItem[] = [
  { id: "new-agent", label: "New agent", kind: "open-sheet", sheet: "new-agent" },
  { id: "new-task", label: "New task", kind: "open-sheet", sheet: "new-task" },
  { id: "new-schedule", label: "New schedule", kind: "open-sheet", sheet: "new-schedule" },
  { id: "agent-details", label: "Agent details", kind: "agent-details", on: "agent" },
  { id: "open-session", label: "Open session", kind: "switch-view", on: "chat" },
  { id: "open-chat", label: "Open chat", kind: "switch-view", on: "session" },
  { id: "theme-system", label: "Theme: System", kind: "theme-system" },
  { id: "theme-light", label: "Theme: Light", kind: "theme-light" },
  { id: "theme-dark", label: "Theme: Dark", kind: "theme-dark" },
  { id: "shortcuts", label: "Keyboard shortcuts", kind: "shortcuts" },
];
