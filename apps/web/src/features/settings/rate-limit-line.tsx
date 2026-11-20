import type { RateLimitState } from "@open-factory/shared";
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import { resetPhrase } from "@/features/session/status-badge";
import { RATE_LIMIT_WINDOW } from "@/features/usage/format";
import { ago, smallClass } from "./shared";

/** Rate-limit lines go stale on their own (a pause ends, a reading ages) and no frame says so: views
 *  that show them refetch on this interval while mounted. */
export const RATE_LIMIT_REFETCH_MS = 60_000;

export type RateLimitInput = {
  rateLimit: RateLimitState | null;
  pausedUntil?: string;
  pauseExact?: boolean;
};

const HOUR = 3_600_000;

/**
 * The displayed state, derived in spec §7's order: a live S5 pause; no observation; a warning
 * whose reset is ahead (or, without a reset, seen within the hour); else within limits.
 */
export function rateLimitState(
  { rateLimit, pausedUntil, pauseExact }: RateLimitInput,
  now = Date.now(),
): { tone: "warning" | "ok" | "none"; text: string } {
  const pause = pausedUntil ? new Date(pausedUntil).getTime() : Number.NaN;
  if (pause > now) {
    const phrase = resetPhrase({ rateLimitedUntil: pausedUntil, rateLimitExact: pauseExact });
    return { tone: "warning", text: `Rate-limited${phrase?.joined ?? ""}` };
  }
  if (!rateLimit) return { tone: "none", text: "No rate-limit data yet" };
  if (rateLimit.status === "allowed_warning") {
    const reset = rateLimit.resetsAt ? new Date(rateLimit.resetsAt).getTime() : null;
    const near =
      reset === null ? now - new Date(rateLimit.observedAt).getTime() < HOUR : reset > now;
    if (near) {
      const window = rateLimit.type
        ? `${RATE_LIMIT_WINDOW[rateLimit.type] ?? rateLimit.type} `
        : "";
      const text =
        rateLimit.utilization === null
          ? `Near the ${window}limit`
          : `${Math.round(rateLimit.utilization * 100)}% of the ${window}limit used`;
      return { tone: "warning", text };
    }
  }
  return { tone: "ok", text: `Within limits · seen ${ago(rateLimit.observedAt, now)}` };
}

/** One line: an icon plus the words, never colour alone (spec §12.9). */
export function RateLimitLine(props: RateLimitInput) {
  const { tone, text } = rateLimitState(props);
  const Icon = tone === "warning" ? TriangleAlert : tone === "ok" ? CircleCheck : CircleDashed;
  return (
    <span className={`inline-flex items-start gap-1.5 ${smallClass} text-muted-foreground`}>
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-3.5 shrink-0 ${tone === "warning" ? "text-warning" : tone === "ok" ? "text-success" : ""}`}
      />
      <span className={tone === "warning" ? "text-foreground" : undefined}>{text}</span>
    </span>
  );
}
