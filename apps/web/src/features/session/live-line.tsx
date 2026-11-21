import type { AgentSummary } from "@open-factory/shared";
import { formatInboxTime, formatResetTime, formatTime } from "./format";
import { formatBy } from "./format-by";

export type LiveFact = {
  kind: "terminated" | "errored" | "queued" | "restart" | "waiting" | "crons";
  text: string;
  /** The full text when `text` is shortened. */
  title?: string;
};

function terminatedText(agent: AgentSummary, now: Date): string {
  const by = agent.terminatedBy ? formatBy(agent.terminatedBy) : null;
  const who =
    by?.kind === "agent"
      ? ` by @${by.slug}`
      : by?.kind === "human"
        ? ` by ${by.handle}`
        : by?.kind === "ttl"
          ? " after 3 days without activity"
          : "";
  const parts = [`Terminated${who}`];
  if (agent.terminatedAt) parts.push(formatInboxTime(new Date(agent.terminatedAt), now));
  if (agent.workspaceDeletedAt) parts.push("workspace deleted");
  else if (agent.workspacePinned) parts.push("workspace pinned");
  else if (agent.workspaceGraceEndsAt) {
    const ends = new Date(agent.workspaceGraceEndsAt);
    parts.push(
      ends.getTime() <= now.getTime() ? "deletion due" : `deletes ${formatResetTime(ends, now)}`,
    );
  }
  return parts.join(" · ");
}

function queuedText(agent: AgentSummary, slotsMax?: number): string | null {
  if (agent.pulling) return "Pulling the image…";
  if (agent.status !== "queued" || !slotsMax) return null;
  return slotsMax === 1 ? "The only slot is in use." : `All ${slotsMax} slots are in use.`;
}

/**
 * The one fact the session header shows beside the status badge (U2 §8.2), the first that applies.
 * Rate-limited has none (the badge carries its reset time). Times are absolute, never ticking.
 */
export function liveFact(
  agent: AgentSummary,
  ctx: { slotsMax?: number; now: Date },
): LiveFact | null {
  if (agent.status === "terminated" || agent.terminatedAt)
    return { kind: "terminated", text: terminatedText(agent, ctx.now) };
  if (agent.status === "errored" && agent.lastError)
    return {
      kind: "errored",
      text: agent.lastError.split("\n", 1)[0] ?? "",
      title: agent.lastError,
    };
  const queued = queuedText(agent, ctx.slotsMax);
  if (queued) return { kind: "queued", text: queued };
  if (agent.restartPending) return { kind: "restart", text: "Restarts when idle" };
  const [first, ...rest] = agent.waitingOn.tasks;
  if (first)
    return {
      kind: "waiting",
      text: `${first.description} · since ${formatTime(first.startedAt)}${rest.length ? ` +${rest.length}` : ""}`,
    };
  const crons = agent.waitingOn.crons;
  if (crons > 0)
    return { kind: "crons", text: `Kept awake by ${crons} ${crons === 1 ? "cron" : "crons"}` };
  return null;
}

/** The fact as a truncating line (hidden below 640px; Agent details' Now carries it there). With
 *  no fact it is an empty, hidden region that takes no room. */
export function LiveLine({ fact }: { fact: LiveFact | null }) {
  if (!fact) return <span role="status" className="hidden" />;
  return (
    <span
      role="status"
      title={fact.title}
      className="hidden min-w-[8rem] grow basis-0 truncate text-[0.8125rem] text-muted-foreground sm:block"
    >
      {fact.text}
    </span>
  );
}
