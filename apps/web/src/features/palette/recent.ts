/** The last opened sessions, newest first, for the palette's empty query and its "recent" tier. */
export const RECENT_AGENTS_PREF = "of-recent-agents";
const MAX_RECENT = 8;

export function readRecentAgents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_AGENTS_PREF) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Moves `agentRef` to the front (a session was opened). */
export function rememberAgent(agentRef: string) {
  const next = [agentRef, ...readRecentAgents().filter((s) => s !== agentRef)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_AGENTS_PREF, JSON.stringify(next));
  } catch {
    // Blocked storage: nothing is remembered.
  }
}
