/** Who acts: a principal (spec §4.1). `id` is the principal's id, which for an agent is its `agents.id`. */
export type Actor = { kind: "agent" | "human"; id: string; ref: string; handle: string };

/**
 * Spec §6.3: who may change a task. Humans always; an agent when it is the creator, the current assignee, or a manager
 * above either. This is the only place that decides: REST and MCP both reach it through `TaskService`, which re-runs it
 * on the task as re-read under its lock.
 */
export function canChange(
  actor: Actor,
  t: { createdById: string; assigneeAgentId: string | null },
  managersOf: (agentId: string) => readonly string[],
): boolean {
  if (actor.kind === "human") return true;
  const id = actor.id;
  if (t.createdById === id || t.assigneeAgentId === id) return true;
  for (const who of [t.createdById, t.assigneeAgentId]) {
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
