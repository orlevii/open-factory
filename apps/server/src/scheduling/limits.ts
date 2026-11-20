/** The agent limits and the timer's bounds (S9 spec §6.2, §7.3, §8.1). Constants, not settings. */
export const MAX_AGENT_SCHEDULES = 20;
export const MIN_AGENT_GAP_MINUTES = 15;
/** 366 days, so a date one calendar year out is never refused. */
export const AGENT_AT_HORIZON_MS = 366 * 86_400_000;
export const TICK_MAX_MS = 60_000;
export const TICK_MIN_MS = 1_000;
export const DUE_BATCH = 100;
/** A firing more than this late after its due time is delivered with `late`. */
export const LATE_MS = 60_000;
/** The firing backoff after a failed transaction: 5 s, 10, 20, 40, then 60 s at most. */
export const backoffMs = (failCount: number) =>
  Math.min(5_000 * 2 ** Math.min(failCount, 4), 60_000);
