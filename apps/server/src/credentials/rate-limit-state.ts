import type { RateLimitState } from "@open-factory/shared";

/** A credential's rate-limit columns (S10 §5): the latest observed status and the pause. */
export type RateLimitColumns = {
  rlStatus: RateLimitState["status"] | null;
  rlType: string | null;
  rlUtilization: number | null;
  rlResetsAt: Date | null;
  rlObservedAt: Date | null;
  rateLimitedUntil: Date | null;
  rateLimitExact: boolean;
};

/**
 * The one mapping of those columns, used by the credential list and Settings → Usage: no state until a status was
 * observed (one without a status reads as `allowed`), and a pause only while it is still in the future.
 */
export function toRateLimitState(
  c: RateLimitColumns,
  now: Date,
): { rateLimit: RateLimitState | null; pausedUntil?: string; pauseExact?: boolean } {
  return {
    rateLimit: c.rlObservedAt
      ? {
          status: c.rlStatus ?? "allowed",
          type: c.rlType,
          utilization: c.rlUtilization,
          resetsAt: c.rlResetsAt ? c.rlResetsAt.toISOString() : null,
          observedAt: c.rlObservedAt.toISOString(),
        }
      : null,
    ...(c.rateLimitedUntil && c.rateLimitedUntil > now
      ? { pausedUntil: c.rateLimitedUntil.toISOString(), pauseExact: c.rateLimitExact }
      : {}),
  };
}
