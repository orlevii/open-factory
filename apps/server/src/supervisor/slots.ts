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
  closing(): boolean;
  /** The agent waits for a start: a wake queue entry or a granted slot (the `queued` status input, spec §5.4). */
  isQueued(agentId: string): boolean;
}

/** Always "granted", for tests that predate the Supervisor. */
export const unlimitedSlots: SlotPort = {
  requestWake: () => "granted",
  release: () => {},
  becameHibernatable: () => {},
  closing: () => false,
  isQueued: () => false,
};
