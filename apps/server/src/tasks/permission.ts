export type Actor =
  | { kind: "agent"; agentId: string; slug: string }
  | { kind: "user"; userId: string; handle: string };

/**
 * Spec §6.3: who may change a task. Humans always; an agent when it is the creator, the current assignee, or a manager
 * above either. This is the only place that decides: REST and MCP both reach it through `TaskService`, which re-runs it
 * on the task as re-read under its lock.
 */
export function canChange(
  actor: Actor,
  t: { createdByAgentId: string | null; assigneeAgentId: string | null },
  managersOf: (agentId: string) => readonly string[],
): boolean {
  if (actor.kind === "user") return true;
  const id = actor.agentId;
  if (t.createdByAgentId === id || t.assigneeAgentId === id) return true;
  for (const who of [t.createdByAgentId, t.assigneeAgentId]) {
    if (who && managersOf(who).includes(id)) return true;
  }
  return false;
}

export function forbiddenSentence(key: string, creator: string, assignee: string | null): string {
  const who = assignee
    ? `creator (${creator}), its assignee (${assignee})`
    : `creator (${creator})`;
  return `Only ${key}'s ${who} or their managers can change it; comment on it instead.`;
}
