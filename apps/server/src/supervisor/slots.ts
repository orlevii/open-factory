/** Why a process start is requested (spec §5.2); recorded as `process_started.reason`. */
export type WakeReason =
  | "message"
  | "scheduled" // a `scheduled` row waits (S9 §8.4); never wakes an errored agent
  | "spawned" // a spawned agent's first wake (S7 §5.6); never wakes an errored agent
  | "compact"
  | "raw" // a human's raw session input (I1 §5.1)
  | "crash_recovery"
  | "restart"
  | "reset"
  | "boot"
  | "boot_resume"
  | "rate_limit_reset"
  | "queued_items"
  | "apply_changes"
  | "task_message" // a task message (S8 §7.4); never wakes an errored agent
  | "member_updates" // member updates passed their debounce (I9 §4.8); an errored agent makes one attempt
  | "agent_message"; // another agent's message (S6 spec §7.3); never wakes an errored agent

/** The seam between an `AgentRuntime` and the Supervisor that owns the running set (spec §5.2, §5.5). */
export interface SlotPort {
  /** Synchronous. "granted": the caller may startNow inline in its own job. "queued": a grant job will come later. "dropped": not eligible. */
  requestWake(
    agentId: string,
    reason: WakeReason,
    inline: boolean,
  ): "granted" | "queued" | "dropped";
  release(agentId: string): void;
  closing(): boolean;
  /** The agent waits for a start: a wake queue entry or a granted slot (the `queued` status input, spec §5.4). */
  isQueued(agentId: string): boolean;
  /** The agent's wake waits for its image to be checked or pulled (spec §11.2; the status frame's `pulling`). */
  isPulling(agentId: string): boolean;
  /** A `rejected` rate limit on the credential (spec §7.2): pause it until `until`; a later window extends, never shortens. */
  pause(credentialId: string, until: Date, exact: boolean): void;
  /** The pause on the agent's credential right now, if any. */
  pauseOf(agentId: string): CredentialPause | undefined;
}

/** A credential's rate-limit window (spec §7.2); `exact` is false for the 30-minute fallback. */
export type CredentialPause = { until: Date; exact: boolean };
