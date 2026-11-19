import type { AgentStatus } from "./agents.ts";

export interface StatusInputs {
  terminated: boolean;
  errored: boolean;
  attempting: boolean;
  working: boolean;
  credentialPaused: boolean;
  hasPendingWork: boolean;
  queuedWake: boolean;
  processRunning: boolean;
}

/** The one owner of status precedence (spec §8.1). */
export function statusOf(i: StatusInputs): AgentStatus {
  if (i.terminated) return "terminated";
  if (i.errored && !i.attempting) return "errored";
  if (i.working) return "working";
  if (i.credentialPaused && (i.processRunning || i.hasPendingWork || i.queuedWake))
    return "rate_limited";
  if (i.queuedWake) return "queued";
  if (i.attempting) return "working";
  if (i.processRunning) return "idle";
  return "hibernated";
}
