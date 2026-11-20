/** Why a process start is requested (spec §5.2); recorded as `process_started.reason`. */
export type WakeReason =
  | "message"
  | "compact"
  | "crash_recovery"
  | "restart"
  | "reset"
  | "boot"
  | "boot_resume"
  | "rate_limit_reset"
  | "queued_items"
  | "apply_changes";

/** The seam between an `AgentRuntime` and the Supervisor that owns the cap (spec §5.2, §5.5). */
export interface SlotPort {
  /** Synchronous. "granted": the caller may startNow inline in its own job. "queued": a grant job will come later. "dropped": not eligible. */
  requestWake(
    agentId: string,
    reason: WakeReason,
    inline: boolean,
  ): "granted" | "queued" | "dropped";
  release(agentId: string): void;
  becameHibernatable(agentId: string): void;
  /** The agent's stop failed even after escalation (spec §9.6): it keeps its slot but is no longer on its way out. */
  stopFailed(agentId: string): void;
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
